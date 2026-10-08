#input_type_name: GetThreadInput
#output_type_name: GetThreadResult

#function_name: get_email_thread

import re
from datetime import datetime, timezone
from email.utils import parseaddr

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

# Read one Gmail conversation so the app can show it beside the Feed — the actual
# messages, oldest first, with quoted history stripped so each message shows only what
# that person wrote. Read-only: never marks read, never labels, never sends.


class GetThreadInput(BaseModel):
    thread_id: str
    # the account the conversation lives in, when the person has more than one mailbox;
    # the app reads it off the row. Empty means the workspace default.
    account_id: str | None = None


class Attachment(BaseModel):
    filename: str = ""
    mime: str = ""
    attachment_id: str = ""


class ThreadMessage(BaseModel):
    id: str = ""
    from_name: str = ""
    from_email: str = ""
    to: list[str] = []
    cc: list[str] = []
    date: str = ""               # ISO, UTC
    subject: str = ""
    body: str = ""               # just this message, quotes stripped
    mine: bool = False
    attachments: list[Attachment] = []


class GetThreadResult(BaseModel):
    subject: str = ""
    messages: list[ThreadMessage] = []
    error: str = ""


_QUOTE = re.compile(
    r"(\n\s*On .{3,160}wrote:\s*\n|\n\s*-{2,}\s*Original Message\s*-{2,}|\n\s*From: .+\n\s*Sent: |\n>)",
    re.I,
)


def _strip(text: str) -> str:
    t = (text or "").replace("\r\n", "\n")
    m = _QUOTE.search("\n" + t)
    if m and m.start() > 20:
        t = t[: m.start() - 1]
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _addrs(raw: str) -> list[str]:
    out = []
    for part in re.split(r"[,;]", raw or ""):
        e = parseaddr(part)[1].lower()
        if e and e not in out:
            out.append(e)
    return out


def _iso(ts) -> str:
    raw = str(ts or "").strip()
    if not raw:
        return ""
    if raw.isdigit():
        return datetime.fromtimestamp(int(raw) / (1000 if len(raw) > 10 else 1), tz=timezone.utc).isoformat()
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
    except ValueError:
        return raw


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


def _o_text(body: dict | None, preview: str = "") -> str:
    import html as _html
    content = (body or {}).get("content") or ""
    if ((body or {}).get("contentType") or "").lower() == "html":
        content = re.sub(r"(?is)<(style|script|head)[^>]*>.*?</\1>", " ", content)
        content = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", content)
        content = _html.unescape(re.sub(r"<[^>]+>", "", content))
    content = re.sub(r"[ \t\r\f\v]+", " ", content)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", content).strip() or (preview or "").strip()


def _outlook_thread(pod, conv: str, res: "GetThreadResult", use: dict) -> "GetThreadResult":
    try:
        msgs = _o_conversation(pod, conv, "full", use)
    except Exception as exc:
        res.error = f"Outlook would not open it: {str(exc)[:160]}"
        return res
    me = _o_me(pod, use)
    for m in msgs:
        f = (m.get("from") or m.get("sender") or {}).get("emailAddress") or {}
        email = (f.get("address") or "").lower()
        atts = []
        if m.get("hasAttachments"):
            try:
                a = _o_unwrap(pod.connectors.execute("outlook", "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", {"message_id": m.get("id")}, **use))
                atts = [Attachment(filename=x.get("name") or "file", mime=x.get("contentType") or "", attachment_id=x.get("id") or "")
                        for x in (a.get("value") or []) if x.get("id") and x.get("name") and not x.get("isInline")]
            except Exception:
                atts = []
        res.messages.append(ThreadMessage(
            id=str(m.get("id") or ""),
            from_name=(f.get("name") or email.split("@")[0]).strip(),
            from_email=email,
            to=[(x.get("emailAddress") or {}).get("address", "").lower() for x in (m.get("toRecipients") or [])],
            cc=[(x.get("emailAddress") or {}).get("address", "").lower() for x in (m.get("ccRecipients") or [])],
            date=_iso(m.get("receivedDateTime") or m.get("sentDateTime")),
            subject=(m.get("subject") or "").strip(),
            body=_strip(_o_text(m.get("body"), m.get("bodyPreview") or "")),
            mine=bool(me and email == me),
            attachments=atts,
        ))
    res.subject = next((x.subject for x in res.messages if x.subject), "")
    if not res.messages:
        res.error = "No messages came back for this conversation."
    return res


async def get_email_thread(ctx: FunctionContext, data: GetThreadInput) -> GetThreadResult:
    pod = Pod.from_env()
    res = GetThreadResult()
    tid = (data.thread_id or "").strip()
    use = {"account_id": data.account_id} if (data.account_id or "").strip() else {}
    if tid.startswith("outlook:"):
        return _outlook_thread(pod, tid[8:], res, use)
    if not re.fullmatch(r"[0-9a-f]{10,24}", tid):
        res.error = "not an email conversation"
        return res
    try:
        resp = pod.connectors.execute("gmail", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {"thread_id": tid}, **use)
        resp = resp.to_dict() if hasattr(resp, "to_dict") else resp
    except Exception as exc:
        res.error = f"Gmail would not open it: {str(exc)[:160]}"
        return res

    r = resp.get("result", resp) if isinstance(resp, dict) else {}
    body = r.get("data", r) if isinstance(r, dict) else {}
    msgs = (body.get("messages") if isinstance(body, dict) else None) or r.get("messages") or []

    for m in msgs:
        name, email = parseaddr(m.get("sender") or m.get("from") or "")
        labels = m.get("labelIds") or []
        text = m.get("messageText") or (m.get("preview") or {}).get("body") or m.get("snippet") or ""
        res.messages.append(ThreadMessage(
            id=str(m.get("messageId") or m.get("id") or ""),
            from_name=(name or email.split("@")[0]).strip('" '),
            from_email=email.lower(),
            to=_addrs(m.get("to") or ""),
            cc=_addrs(m.get("cc") or ""),
            date=_iso(m.get("messageTimestamp") or m.get("internalDate") or m.get("date")),
            subject=(m.get("subject") or "").strip(),
            body=_strip(text),
            mine="SENT" in labels,
            attachments=[
                Attachment(filename=a.get("filename") or "file", mime=a.get("mimeType") or "",
                           attachment_id=a.get("attachmentId") or "")
                for a in (m.get("attachmentList") or [])
                if a.get("attachmentId") and a.get("filename")
            ],
        ))
    res.messages.sort(key=lambda x: x.date)
    res.subject = next((x.subject for x in res.messages if x.subject), "")
    if not res.messages:
        res.error = "No messages came back for this conversation."
    return res
