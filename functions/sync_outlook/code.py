#input_type_name: SyncOutlookInput
#output_type_name: SyncOutlookResult
#function_name: sync_outlook

"""Outlook into the interaction ledger: mail, and the Outlook calendar.

The Outlook twin of sync_gmail and sync_calendar, for people whose work lives in
Microsoft 365. It shapes rows exactly as those two do, so nothing downstream knows
or cares which mailbox a row came from:

  * mail lands with source "gmail" — in the ledger that value simply means "email" —
    and a thread_ref of "outlook:<conversation id>", which is how the thread reader
    and the send path know to go to Outlook;
  * calendar events land with source "calendar".

Forms no opinion about content: meaning is the reader's job.
"""

import html
import re
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod


class SyncOutlookInput(BaseModel):
    what: str = "mail"                 # mail | calendar | both
    days: int = 21                     # mail: how far back, when no window is given
    since: str | None = None           # mail: ISO lower bound (inclusive)
    until: str | None = None           # mail: ISO upper bound (exclusive)
    max_messages: int = 80
    past_days: int = 21                # calendar window
    future_days: int = 14
    max_events: int = 150
    body_chars: int = 20000
    batch_size: int = 10
    account_id: str | None = None      # one account only; omit to read every Outlook of mine


class SyncOutlookResult(BaseModel):
    fetched: int = 0
    shaped: int = 0
    recorded: int = 0
    skipped_duplicate: int = 0
    files_written: int = 0
    errors: list[str] = []
    accounts: int = 0


_TAG = re.compile(r"<[^>]+>")


def _text(body: dict | None, preview: str = "") -> str:
    content = (body or {}).get("content") or ""
    if ((body or {}).get("contentType") or "").lower() == "html":
        content = re.sub(r"(?is)<(style|script|head)[^>]*>.*?</\1>", " ", content)
        content = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", content)
        content = html.unescape(_TAG.sub("", content))
    content = re.sub(r"[ \t\r\f\v]+", " ", content)
    content = re.sub(r"\n\s*\n\s*\n+", "\n\n", content).strip()
    return content or (preview or "").strip()


def _who(x: dict | None) -> tuple[str, str]:
    e = (x or {}).get("emailAddress") or {}
    addr = (e.get("address") or "").strip().lower()
    return ((e.get("name") or addr.split("@")[0]).strip(), addr)


def _unwrap(resp) -> dict:
    resp = resp.to_dict() if hasattr(resp, "to_dict") else resp
    r = resp.get("result", resp) if isinstance(resp, dict) else {}
    d = r.get("data", r) if isinstance(r, dict) else {}
    return d if isinstance(d, dict) else {}


def _my_address(pod: Pod, fallback: str, use: dict) -> str:
    try:
        p = _unwrap(pod.connectors.execute("outlook", "OUTLOOK_GET_PROFILE", {"user_id": "me"}, **use))
        return (p.get("mail") or p.get("userPrincipalName") or fallback or "").strip().lower()
    except Exception:
        return (fallback or "").lower()


def _record(pod: Pod, interactions: list[dict], res: SyncOutlookResult, batch: int) -> None:
    for i in range(0, len(interactions), batch):
        try:
            out = pod.functions.run(
                "record_interaction", {"interactions": interactions[i:i + batch]}).to_dict()
        except Exception as exc:
            res.errors.append(f"batch at {i} failed: {str(exc)[:160]}")
            continue
        d = out.get("output_data") or {}
        res.recorded += d.get("created", 0)
        res.skipped_duplicate += d.get("skipped_duplicate", 0)
        res.files_written += d.get("files_written", 0)
        res.errors += (d.get("errors") or [])[:3]


def _mail(pod: Pod, data: SyncOutlookInput, me: str, mine: set, acct: dict, res: SyncOutlookResult) -> list[dict]:
    use = {"account_id": acct["id"]} if acct.get("id") else {}
    now = datetime.now(timezone.utc)
    since = data.since or (now - timedelta(days=data.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw: list[tuple[dict, bool]] = []
    # the inbox and what was sent: a reply the person wrote is half of every thread
    for folder, sent in (("inbox", False), ("sentitems", True)):
        token, guard = None, 0
        share = max(10, data.max_messages // 2) if folder == "sentitems" else data.max_messages
        got = 0
        while got < share and guard < 20:
            guard += 1
            payload = {
                "folder": folder, "top": min(50, share - got), "response_detail": "full",
                "received_date_time_ge": since, "orderby": ["receivedDateTime desc"],
            }
            if data.until:
                payload["received_date_time_lt"] = data.until
            if token:
                payload["page_token"] = token
            try:
                body = _unwrap(pod.connectors.execute("outlook", "OUTLOOK_LIST_MESSAGES", payload, **use))
            except Exception as exc:
                res.errors.append(f"{folder}: {str(exc)[:160]}")
                break
            msgs = body.get("value") or []
            raw += [(m, sent) for m in msgs]
            got += len(msgs)
            token = body.get("next_page_token")
            if not token or not msgs:
                break
    res.fetched += len(raw)

    out: list[dict] = []
    for m, in_sent in raw:
        if not isinstance(m, dict) or m.get("isDraft"):
            continue
        # invitations and their accept/decline receipts are calendar traffic, not mail
        if "eventMessage" in (m.get("@odata.type") or ""):
            continue
        ext = (m.get("internetMessageId") or m.get("id") or "").strip()
        if not ext:
            continue
        from_name, from_email = _who(m.get("from") or m.get("sender"))
        to_addrs = [a for a in (_who(x)[1] for x in (m.get("toRecipients") or [])) if a]
        cc_addrs = [a for a in (_who(x)[1] for x in (m.get("ccRecipients") or [])) if a]
        outbound = in_sent or from_email in mine or (me and from_email == me)
        if outbound:
            counterpart = next((a for a in to_addrs if a != me), "")
        else:
            counterpart = from_email if from_email != me else ""

        # a note between my own mailboxes is not a conversation with anybody (the morning
        # brief is one: from me, to me)
        if counterpart in mine or (from_email in mine and to_addrs and all(a in mine for a in to_addrs)):
            continue

        participants = [{"name": from_name, "email": from_email, "role": "from"}]
        participants += [{"email": a, "role": "to"} for a in to_addrs[:12]]
        participants += [{"email": a, "role": "cc"} for a in cc_addrs[:12]]

        conv = m.get("conversationId") or ""
        out.append({
            "kind": "email",
            "source": "gmail",          # the ledger's word for "email", whichever mailbox
            "external_id": ext,
            "thread_ref": f"outlook:{conv}" if conv else ext,
            "account_id": acct.get("id") or None,
            "occurred_at": m.get("receivedDateTime") or m.get("sentDateTime") or now.isoformat(),
            "subject": (m.get("subject") or "(no subject)").strip(),
            "body": _text(m.get("body"), m.get("bodyPreview") or "")[: data.body_chars],
            "direction": "outbound" if outbound else "inbound",
            "addressed_to_me": bool(outbound or any(a in mine for a in to_addrs) or not me),
            "person_email": counterpart,
            "company_domain": counterpart.split("@")[-1] if "@" in counterpart else None,
            "participants": participants,
        })
    return out


# calendars read in full during this run, for the ledger to drop what has gone from them
_PRUNE: list[dict] = []


def _calendar(pod: Pod, data: SyncOutlookInput, me: str, mine: set, acct: dict, res: SyncOutlookResult) -> list[dict]:
    use = {"account_id": acct["id"]} if acct.get("id") else {}
    now = datetime.now(timezone.utc)
    try:
        body = _unwrap(pod.connectors.execute("outlook", "OUTLOOK_GET_CALENDAR_VIEW", {
            "start_datetime": (now - timedelta(days=data.past_days)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end_datetime": (now + timedelta(days=data.future_days)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "top": data.max_events, "timezone": "UTC", "orderby": "start/dateTime asc",
        }, **use))
    except Exception as exc:
        res.errors.append(f"calendar: {str(exc)[:160]}")
        return []
    items = body.get("value") or []
    res.fetched += len(items)
    # a full read of the window says what is still on this calendar
    if items and len(items) < data.max_events:
        now_ = datetime.now(timezone.utc)
        _PRUNE.append({
            "prefix": "ocal:", "account_id": acct.get("id") or None,
            "start": (now_ - timedelta(days=data.past_days)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": (now_ + timedelta(days=data.future_days)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "keep": [f"ocal:{ev['id']}" for ev in items if ev.get("id") and not ev.get("isCancelled")],
        })

    out: list[dict] = []
    for ev in items:
        if ev.get("isCancelled") or not ev.get("id"):
            continue
        start = ((ev.get("start") or {}).get("dateTime") or "")[:19]
        if not start:
            continue
        start += "Z"                    # the view was asked for in UTC
        attendees = []
        for a in (ev.get("attendees") or []):
            name, em = _who(a)
            if not em or em == me or em in mine or (a.get("type") or "").lower() == "resource":
                continue
            attendees.append({"email": em, "name": name, "role": "attendee"})
        title = (ev.get("subject") or "(untitled)").strip()
        # A one-to-one is with that person. A group meeting has no single counterparty.
        counterpart = attendees[0]["email"] if len(attendees) == 1 else ""

        lines = [f"Meeting: {title}", f"When: {start}"]
        where = ((ev.get("location") or {}).get("displayName") or "").strip()
        if where:
            lines.append(f"Where: {where}")
        join = ((ev.get("onlineMeeting") or {}).get("joinUrl") or "").strip()
        if join:
            lines.append(f"Meeting link: {join}")
        if ev.get("seriesMasterId"):
            lines.append("This is one occurrence of a recurring series.")
        if attendees:
            lines.append("Attendees: " + ", ".join(f"{a['name']} <{a['email']}>" for a in attendees[:20]))
        notes = _text(ev.get("body"), ev.get("bodyPreview") or "")
        if notes:
            lines.append("\nAgenda / description:\n" + notes[:4000])

        out.append({
            "kind": "meeting",
            "source": "calendar",
            "external_id": f"ocal:{ev['id']}",
            "thread_ref": f"ocal:{ev.get('seriesMasterId') or ev['id']}",
            "account_id": acct.get("id") or None,
            "occurred_at": start,
            "subject": title,
            "body": "\n".join(lines),
            "direction": "internal",
            "addressed_to_me": True,
            "person_email": counterpart,
            "company_domain": counterpart.split("@")[-1] if "@" in counterpart else None,
            "participants": attendees,
        })
    return out



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


async def sync_outlook(ctx: FunctionContext, data: SyncOutlookInput) -> SyncOutlookResult:
    pod = Pod.from_env()
    res = SyncOutlookResult()
    what = (data.what or "mail").lower()

    mine = _my_addresses(pod, ctx)
    accounts = _my_accounts(pod, ctx, "outlook")
    if data.account_id:
        accounts = [a for a in accounts if a["id"] == data.account_id] or [{"id": data.account_id, "email": ""}]
    if not accounts:
        accounts = [{"id": "", "email": ""}]      # the workspace default, as before
    res.accounts = len([a for a in accounts if a["id"]])

    _PRUNE.clear()
    interactions: list[dict] = []
    for acct in accounts:
        use = {"account_id": acct["id"]} if acct["id"] else {}
        me = acct["email"] or _my_address(pod, ctx.user_email or "", use)
        if me:
            mine.add(me)
        if what in ("mail", "both"):
            interactions += _mail(pod, data, me, mine, acct, res)
        if what in ("calendar", "both"):
            interactions += _calendar(pod, data, me, mine, acct, res)
    res.shaped = len(interactions)
    _record(pod, interactions, res, data.batch_size)
    for w in _PRUNE:
        try:
            pod.functions.run("record_interaction", {"interactions": [], "prune": w})
        except Exception as exc:
            res.errors.append(f"prune: {str(exc)[:120]}")
    _PRUNE.clear()
    return res
