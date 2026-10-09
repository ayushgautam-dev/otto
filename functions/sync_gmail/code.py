#input_type_name: SyncGmailInput
#output_type_name: SyncGmailResult
#function_name: sync_gmail

# Gmail -> the interaction ledger. This function talks to Gmail, shapes what it
# finds into normalised interactions, and hands them to `record_interaction`.
#
# It forms no opinion about content: no keyword filters, no "is this a newsletter"
# guesses, no obligation detection. Whether a message means anything is decided
# later by the extractor, which reads the ledger. All this does is parse and pass on.
#
# Unlike the older fetch_recent_emails, the body is NOT truncated to a snippet —
# the whole text is kept, because the stored copy is what the second brain searches
# and what a better extractor will re-read later.

import re
from datetime import datetime, timezone
from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod


class SyncGmailInput(BaseModel):
    days: int = 30
    max_messages: int = 200
    query: str | None = None
    message_ids: list[str] | None = None     # set by the webhook path for a single new mail
    body_chars: int = 20000
    batch_size: int = 15
    account_id: str | None = None            # one account only; omit to read every Gmail of mine


class SyncGmailResult(BaseModel):
    fetched: int = 0
    shaped: int = 0
    recorded: int = 0
    skipped_duplicate: int = 0
    files_written: int = 0
    errors: list[str] = []
    accounts: int = 0                        # how many of my Gmail accounts were read
    threads: list[str] = []                  # conversations this run touched


def _addr(raw: str) -> tuple[str, str]:
    raw = (raw or "").strip()
    m = re.match(r"^\s*(.*?)\s*<([^>]+)>\s*$", raw)
    if m:
        return (m.group(1).strip().strip('"') or m.group(2).split("@")[0], m.group(2).strip().lower())
    if "@" in raw:
        return (raw.split("@")[0], raw.strip().lower())
    return (raw, "")


def _split(raw: str) -> list[str]:
    return [a for a in (_addr(x)[1] for x in re.split(r"[,;]", raw or "")) if a]


_HTMLISH = re.compile(r"</?(p|br|div|span|table|tr|td|html|body|a|b|strong|em|ul|ol|li|h[1-6]|blockquote|font)\b[^>]*>", re.I)


def _plain(text: str) -> str:
    """Some senders' mail arrives as HTML even in the "text" field. Show it as words:
    paragraphs and line breaks become new lines, every other tag goes, entities are decoded."""
    t = text or ""
    if not _HTMLISH.search(t):
        return t
    import html as _html
    t = re.sub(r"(?is)<(style|script|head)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>|</h[1-6]>|</blockquote>", "\n", t)
    t = _html.unescape(re.sub(r"<[^>]+>", "", t))
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", t).strip()


def _iso(ts: str) -> str:
    raw = (ts or "").strip()
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    if len(raw) >= 10:
        try:
            return datetime.strptime(raw[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    return datetime.now(timezone.utc).isoformat()



# ---- Which accounts are mine. ----
# A person may connect several mailboxes (two Gmails, a Gmail and an Outlook). Connected
# accounts belong to the organisation, so everything here is narrowed to the accounts
# of the person this run is for: nobody's run may ever touch somebody else's mailbox.

def _items(x) -> list:
    x = x.to_dict() if hasattr(x, "to_dict") else x
    return x.get("items", []) if isinstance(x, dict) else (x or [])


def _my_accounts(pod, ctx, connector: str) -> list[dict]:
    """My connected accounts for one connector: [{id, email}], the default one first."""
    uid = str(getattr(ctx, "user_id", "") or "")
    out = []
    if not uid:
        # without knowing who this run is for, nothing can be called "mine": the caller
        # falls back to the workspace default rather than reading every mailbox in it
        return out
    try:
        for a in _items(pod.connectors.accounts.list()):
            if a.get("status") != "CONNECTED" or str(a.get("connector_id") or "").lower() != connector:
                continue
            if str(a.get("user_id") or "") != uid:
                continue
            out.append({"id": str(a.get("id")), "email": (a.get("email") or "").strip().lower(),
                        "default": bool(a.get("is_default"))})
    except Exception:
        return []
    return sorted(out, key=lambda a: not a["default"])


def _my_addresses(pod, ctx) -> set[str]:
    """Every address that is me, across all my mailboxes."""
    mine = {(getattr(ctx, "user_email", "") or "").strip().lower()}
    for c in ("gmail", "outlook"):
        mine |= {a["email"] for a in _my_accounts(pod, ctx, c)}
    return {m for m in mine if m}


async def sync_gmail(ctx: FunctionContext, data: SyncGmailInput) -> SyncGmailResult:
    pod = Pod.from_env()
    res = SyncGmailResult()
    me = (ctx.user_email or "").lower()

    query = data.query or (
        f"newer_than:{data.days}d -in:spam -in:trash "
        "-category:promotions -category:social -category:forums"
    )

    # Every Gmail of mine, or just the one asked for. With none listed (an older pod, or
    # accounts that could not be read) fall back to the workspace's default account.
    mine = _my_addresses(pod, ctx)
    accounts = _my_accounts(pod, ctx, "gmail")
    if data.account_id:
        accounts = [a for a in accounts if a["id"] == data.account_id] or [{"id": data.account_id, "email": ""}]
    if not accounts:
        accounts = [{"id": "", "email": me}]

    res.accounts = len([a for a in accounts if a["id"]])
    raw: list[tuple[dict, dict]] = []
    for acct in accounts:
        use = {"account_id": acct["id"]} if acct["id"] else {}
        got: list[dict] = []
        if data.message_ids:
            for mid in data.message_ids[:50]:
                try:
                    r = pod.connectors.execute(
                        "gmail", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
                        {"message_id": mid, "format": "full"}, **use).to_dict()
                    r = r.get("result", r)
                    got.append(r.get("data", r))
                except Exception as exc:
                    res.errors.append(f"{mid}: {exc}")
        else:
            page_token, guard = None, 0
            while len(got) < data.max_messages and guard < 40:
                guard += 1
                payload = {
                    "query": query,
                    "max_results": min(50, data.max_messages - len(got)),
                    "verbose": True,
                    "include_spam_trash": False,
                }
                if page_token:
                    payload["page_token"] = page_token
                try:
                    resp = pod.connectors.execute("gmail", "GMAIL_FETCH_EMAILS", payload, **use).to_dict()
                except Exception as exc:
                    res.errors.append(str(exc))
                    break
                r = resp.get("result", resp)
                body = r.get("data", r) if isinstance(r, dict) else {}
                msgs = body.get("messages") or r.get("messages") or []
                got.extend(msgs)
                page_token = body.get("nextPageToken") or r.get("nextPageToken")
                if not page_token or not msgs:
                    break

        raw += [(m, acct) for m in got]

    res.fetched = len(raw)

    interactions: list[dict] = []
    for m, acct in raw:
        if not isinstance(m, dict):
            continue
        me = acct.get("email") or me
        gmail_id = m.get("messageId") or m.get("id")
        # RFC Message-ID is stable across mailboxes; the Gmail id is only stable here.
        ext = (m.get("rfc822MessageId") or m.get("messageId") or gmail_id or "").strip()
        if not ext:
            continue

        from_name, from_email = _addr(m.get("sender", ""))
        to_addrs, cc_addrs = _split(m.get("to", "")), _split(m.get("cc", ""))
        labels = m.get("labelIds") or []
        outbound = "SENT" in labels or from_email in mine or (me and from_email == me)

        # Who is this with? For mail I sent, the counterparty is the first recipient.
        counterpart = ""
        if outbound:
            counterpart = next((a for a in to_addrs if a != me), "")
        else:
            counterpart = from_email if from_email != me else ""

        # a note between my own mailboxes is not a conversation with anybody (the morning
        # brief is one: from me, to me)
        if counterpart in mine or (from_email in mine and to_addrs and all(a in mine for a in to_addrs)):
            continue

        body_text = _plain(m.get("messageText") or (m.get("preview") or {}).get("body") or "").strip()

        participants = [{"name": from_name, "email": from_email, "role": "from"}]
        participants += [{"email": a, "role": "to"} for a in to_addrs[:12]]
        participants += [{"email": a, "role": "cc"} for a in cc_addrs[:12]]

        interactions.append({
            "kind": "email",
            "source": "gmail",
            "external_id": ext,
            "thread_ref": m.get("threadId") or ext,
            "account_id": acct.get("id") or None,
            "occurred_at": _iso(m.get("messageTimestamp", "")),
            "subject": (m.get("subject") or "(no subject)").strip(),
            "body": body_text[: data.body_chars],
            "direction": "outbound" if outbound else "inbound",
            # Copied-in threads become context, never obligations. The extractor is
            # told to respect this flag rather than re-deriving it.
            "addressed_to_me": bool(outbound or any(a in mine for a in to_addrs) or not me),
            "person_email": counterpart,
            "company_domain": counterpart.split("@")[-1] if "@" in counterpart else None,
            "participants": participants,
        })

    res.shaped = len(interactions)
    res.threads = sorted({i["thread_ref"] for i in interactions if i.get("thread_ref")})[:60]
    # Chunked: each interaction carries a full body and triggers a file write, so a
    # whole 30-day backfill in one call times out. Batches keep each call small and
    # let a partial failure keep the work already done.
    for i in range(0, len(interactions), data.batch_size):
        chunk = interactions[i:i + data.batch_size]
        try:
            out = pod.functions.run(
                "record_interaction", {"interactions": chunk}).to_dict()
        except Exception as exc:
            res.errors.append(f"batch at {i} failed: {str(exc)[:160]}")
            continue
        d = out.get("output_data") or {}
        res.recorded += d.get("created", 0)
        res.skipped_duplicate += d.get("skipped_duplicate", 0)
        res.files_written += d.get("files_written", 0)
        res.errors += (d.get("errors") or [])[:3]

    return res
