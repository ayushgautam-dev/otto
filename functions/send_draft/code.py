#input_type_name: SendDraftInput
#output_type_name: SendDraftResult

#function_name: send_draft

import html
import re
from datetime import datetime, timezone

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

# The one place a message actually leaves the building.
#
# v1's bug: the app's Send button only flipped drafts.status to 'sent' and closed the loop.
# Nothing was ever handed to Gmail, so the user was told "Sent" while the message sat in a
# table. Seven drafts accumulated that way. The rule here is the opposite and absolute:
# nothing is marked sent and nothing is closed until Gmail has accepted the message.
#
# Replies go inside the original thread whenever we know it. That keeps the conversation
# readable for the recipient and — because autoresolve matches on thread — it is also what
# lets the commitment close itself later.


class SendDraftInput(BaseModel):
    draft_id: str
    subject: str | None = None   # the user may have edited before pressing Send
    body: str | None = None
    # The app sends the whole draft as it stands on screen. A function invoked from the
    # app runs as the service identity and cannot read RLS rows (measured: every query
    # returns 0 rows), so looking the draft up here answered "draft not found" for every
    # Send ever pressed. The row lookup stays as a fallback for agent/workflow callers.
    to_email: str | None = None
    to_name: str | None = None
    cc: list[str] | None = None
    extra_to: list[str] | None = None
    thread_ref: str | None = None
    # Which of the person's mailboxes this goes out from, when they have more than one:
    # the connected account's id, and whether it is a "gmail" or an "outlook" account.
    # A reply goes from the account its conversation lives in; the app reads both off
    # the row. Empty means the workspace default, as before.
    account_id: str | None = None
    provider: str | None = None
    # A document Lem prepared for this commitment, already rendered to HTML by the app.
    # Gmail attachments need a file in Composio's own storage, which we cannot produce, so
    # the document travels inside the email, below the note, under an "Attached" heading.
    appendix_html: str | None = None


class SendDraftResult(BaseModel):
    sent: bool = False
    mode: str = ""               # "reply" | "new"
    to: str = ""
    thread_ref: str = ""
    loop_closed: bool = False
    error: str = ""


def _to_html(text: str) -> str:
    safe = html.escape(text or "").strip()
    paras = [p.strip() for p in re.split(r"\n\s*\n", safe) if p.strip()]
    return "".join("<p>" + p.replace("\n", "<br>") + "</p>" for p in paras) or "<p></p>"


def _emails(xs: list[str] | None) -> list[str]:
    out = []
    for x in xs or []:
        x = (x or "").strip().lower()
        if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", x) and x not in out:
            out.append(x)
    return out


# ---- Outlook. A thread_ref of "outlook:<conversation id>" is an Outlook conversation. ----

def _o_unwrap(resp) -> dict:
    resp = resp.to_dict() if hasattr(resp, "to_dict") else resp
    r = resp.get("result", resp) if isinstance(resp, dict) else {}
    d = r.get("data", r) if isinstance(r, dict) else {}
    return d if isinstance(d, dict) else {}


def _o_conversation(pod, conv: str, detail: str = "minimal", use: dict | None = None) -> list[dict]:
    """Every message in one Outlook conversation, across folders, oldest first."""
    body = _o_unwrap(pod.connectors.execute("outlook", "OUTLOOK_LIST_MESSAGES", {
        "folder": "allfolders", "top": 50, "response_detail": detail,
        "filter": "conversationId eq '" + conv.replace("'", "''") + "'",
    }, **(use or {})))
    msgs = [m for m in (body.get("value") or []) if not m.get("isDraft")]
    return sorted(msgs, key=lambda m: m.get("receivedDateTime") or m.get("sentDateTime") or "")


def _o_me(pod, use: dict | None = None) -> str:
    try:
        p = _o_unwrap(pod.connectors.execute("outlook", "OUTLOOK_GET_PROFILE", {"user_id": "me"}, **(use or {})))
        return (p.get("mail") or p.get("userPrincipalName") or "").strip().lower()
    except Exception:
        return ""


def _mail_is_outlook(pod) -> bool:
    """With no thread to tell us, send through whichever mailbox the person connected:
    Outlook only when it is connected and Gmail is not."""
    try:
        st = pod.connectors.status()
        on = {str(a.get("connector_id") or "").lower() for a in (st.get("connected_accounts") or st.get("accounts") or [])
              if isinstance(a, dict) and a.get("status") == "CONNECTED"}
        return "outlook" in on and "gmail" not in on
    except Exception:
        return False


async def send_draft(ctx: FunctionContext, data: SendDraftInput) -> SendDraftResult:
    pod = Pod.from_env()
    res = SendDraftResult()

    d: dict = {}
    try:
        rows = pod.query(
            "select d.id, d.status, d.subject, d.body, d.loop_id, "
            "coalesce(p.name,'') as to_name, coalesce(p.email,'') as to_email, "
            "coalesce(l.thread_ref,'') as thread_ref, coalesce(l.obligation,'') as obligation, "
            "l.person_id as person_id "
            "from drafts d "
            "left join people p on p.id = d.to_person_id "
            "left join loops l on l.id = d.loop_id "
            f"where d.id = '{data.draft_id}' limit 1"
        ).to_dict()["items"]
        d = rows[0] if rows else {}
    except Exception:
        d = {}

    if (d.get("status") or "") == "sent":
        res.error = "already sent"
        return res

    to_email = (data.to_email or d.get("to_email") or "").strip()
    if not to_email:
        res.error = "no email address for this person"
        return res

    subject = (data.subject if data.subject is not None else d.get("subject")) or ""
    body = (data.body if data.body is not None else d.get("body")) or ""
    if not body.strip():
        res.error = "nothing to send — the draft is empty"
        return res

    thread_ref = (data.thread_ref if data.thread_ref is not None else d.get("thread_ref") or "").strip()
    outlook_conv = thread_ref[8:] if thread_ref.startswith("outlook:") else ""
    # granola:/gcal:/seed- refs are not mail threads — replying into them would fail
    if thread_ref and not outlook_conv and not re.fullmatch(r"[0-9a-f]{10,24}", thread_ref):
        thread_ref = ""
    cc = [e for e in _emails(data.cc) if e != to_email.lower()]
    extra = [e for e in _emails(data.extra_to) if e != to_email.lower() and e not in cc]
    res.to = to_email
    res.thread_ref = thread_ref

    html_body = _to_html(body)
    if (data.appendix_html or "").strip():
        html_body += (
            '<div style="margin-top:28px;padding-top:16px;border-top:1px solid #ddd;'
            'font-family:Arial,sans-serif;font-size:14px;line-height:1.5">'
            + data.appendix_html + "</div>"
        )

    # --- the send itself. Everything after this only runs if the mailbox accepted. ---
    use = {"account_id": data.account_id} if (data.account_id or "").strip() else {}
    provider = (data.provider or "").strip().lower()
    via_outlook = bool(outlook_conv) or (not thread_ref and (provider == "outlook" or (not provider and _mail_is_outlook(pod))))
    if via_outlook:
        try:
            last = None
            if outlook_conv:
                me = _o_me(pod, use)
                msgs = _o_conversation(pod, outlook_conv, "minimal", use)
                # reply to the latest message that is not the person's own, else the latest
                theirs = [m for m in msgs if ((m.get("from") or {}).get("emailAddress") or {}).get("address", "").lower() != me]
                last = (theirs or msgs or [None])[-1]
            if last:
                res.mode = "reply"
                args = {"message_id": last["id"], "comment": html_body, "is_html": True, "user_id": "me"}
                if cc or extra:
                    args["cc_emails"] = cc + extra
                pod.connectors.execute("outlook", "OUTLOOK_REPLY_EMAIL", args, **use)
            else:
                res.mode = "new"
                args = {"to": ", ".join([to_email] + extra), "subject": subject or "(no subject)",
                        "body": html_body, "is_html": True, "user_id": "me", "save_to_sent_items": True}
                if cc:
                    args["cc_emails"] = cc
                pod.connectors.execute("outlook", "OUTLOOK_SEND_EMAIL", args, **use)
        except Exception as exc:
            res.error = f"Outlook refused the message: {str(exc)[:200]}"
            return res
    else:
        try:
            if thread_ref:
                res.mode = "reply"
                args = {
                    "thread_id": thread_ref,
                    "recipient_email": to_email,
                    "message_body": html_body,
                    "is_html": True,
                }
            else:
                res.mode = "new"
                args = {
                    "recipient_email": to_email,
                    "subject": subject or "(no subject)",
                    "body": html_body,
                    "is_html": True,
                }
            if cc:
                args["cc"] = cc
            if extra:
                args["extra_recipients"] = extra
            pod.connectors.execute("gmail", "GMAIL_REPLY_TO_THREAD" if thread_ref else "GMAIL_SEND_EMAIL", args, **use)
        except Exception as exc:
            res.error = f"Gmail refused the message: {str(exc)[:200]}"
            return res          # nothing marked, nothing closed — the draft stays pending

    res.sent = True
    if not d:
        # The app does the bookkeeping (it can see the rows); we only report the send.
        return res

    now = datetime.now(timezone.utc).isoformat()
    try:
        pod.records.update("drafts", d["id"], {"status": "sent", "subject": subject, "body": body})
        if d.get("loop_id"):
            pod.records.update("loops", d["loop_id"], {
                "status": "closed",
                "closed_at": now,
                "closed_by": "manual",
                "close_reason": f"You sent a {'reply' if thread_ref else 'message'} to {d.get('to_name') or to_email}",
            })
            res.loop_closed = True
    except Exception as exc:
        res.error = f"sent, but logging failed: {str(exc)[:120]}"
    return res
