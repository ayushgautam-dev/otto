#input_type_name: SendBriefInput
#output_type_name: SendBriefResult
#function_name: send_brief_email

# Emails the founder their own morning brief.
#
# On the product's "never act outward without a yes" rule: this is the one exception
# the founder asked for, and it is safe because it is not outward. The only address
# this can ever send to is the founder's own — the recipient is taken from the run's
# identity and cannot be passed in. It cannot message a third party even by mistake.
#
# The brief normally goes from Otto's own address, so that a reply lands with Otto and
# gets acted on; a brief sent from the person to themselves is a dead end, with nothing
# listening on the other side of Reply. Only Otto can send as Otto (it is a tool the
# assistant holds, and not something a function can be granted), so Otto sends it and
# calls this with delivered_by_otto to record that it went. This function's own send,
# through the person's mailbox, is the fallback for when Otto's address cannot reach them.
#
# One message a day. That is the whole notification design: the promise is fewer
# interruptions, not more.

import html
import re
from datetime import datetime, timezone
from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod


class SendBriefInput(BaseModel):
    # Send even when one already went out today. Off by default so a retry or a second
    # schedule firing cannot produce two emails.
    force: bool = False
    subject_prefix: str = "Your brief"
    # The whole subject line, written by whoever composed the brief so it can say what is
    # inside ("Mon 12 Oct: 3 meetings, 2 overdue, 1 draft waiting") in the person's own
    # date. Empty falls back to the prefix and today's date.
    subject: str = ""
    # True when Otto has already emailed today's brief from its own address. Nothing is
    # sent; the run is only recorded.
    delivered_by_otto: bool = False
    # The designed email from render_brief. When given, the mailbox fallback sends this
    # rather than a plain rendering of the stored text, so both routes look the same.
    html: str = ""


class SendBriefResult(BaseModel):
    sent: bool = False
    to: str = ""
    subject: str = ""
    reason: str = ""
    via: str = ""          # "otto" (Otto's own address, replies reach Otto) or "mailbox"
    errors: list[str] = Field(default_factory=list)


def _md_to_html(text: str) -> str:
    out = []
    for raw in (text or "").splitlines():
        line = html.escape(raw.rstrip())
        line = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", line)
        line = re.sub(r"\*(.+?)\*", r"<em>\1</em>", line)
        stripped = line.strip()
        if not stripped:
            out.append("<div style='height:10px'></div>")
        elif stripped.startswith("### "):
            out.append(f"<h3 style='margin:18px 0 6px;font-size:15px'>{stripped[4:]}</h3>")
        elif stripped.startswith("## "):
            out.append(f"<h2 style='margin:20px 0 8px;font-size:17px'>{stripped[3:]}</h2>")
        elif stripped.startswith("# "):
            out.append(f"<h1 style='margin:0 0 10px;font-size:20px'>{stripped[2:]}</h1>")
        elif stripped.startswith(("- ", "* ")):
            out.append(
                "<div style='margin:3px 0 3px 14px;padding-left:10px;"
                f"border-left:2px solid #d8d3c8'>{stripped[2:]}</div>")
        else:
            out.append(f"<p style='margin:6px 0'>{stripped}</p>")
    return (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
        "font-size:14px;line-height:1.6;color:#1f1e1c;max-width:620px\">"
        + "\n".join(out) +
        "<p style='margin-top:26px;padding-top:12px;border-top:1px solid #e6e2d9;"
        "color:#78756e;font-size:12px'>Everything above was read, not entered. "
        "Nothing else will interrupt you today.</p></div>"
    )


async def send_brief_email(ctx: FunctionContext, data: SendBriefInput) -> SendBriefResult:
    pod = Pod.from_env()
    res = SendBriefResult()

    me = (ctx.user_email or "").strip()
    if not me:
        res.reason = "no address on the run identity; refusing to send"
        return res
    res.to = me

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    found = rows("select content, composed_on from briefs order by composed_on desc limit 1")
    if not found or not (found[0].get("content") or "").strip():
        res.reason = "no brief composed yet"
        return res

    brief = found[0]
    composed = str(brief.get("composed_on") or "")[:10]
    if composed and composed != today and not data.force:
        res.reason = f"latest brief is from {composed}, not today; not sending a stale brief"
        return res

    body = brief["content"].strip()
    res.subject = " ".join((data.subject or "").split())[:200] or (
        f"{data.subject_prefix} — {datetime.now(timezone.utc).strftime('%a %d %b')}")

    # Otto already sent it from its own address: nothing to send, only the audit line.
    if data.delivered_by_otto:
        res.sent, res.via, res.reason = True, "otto", "sent"
        return _logged(pod, res, me, today)

    # From the person's primary mailbox when they chose one (settings.primary_mail_account
    # holds "gmail:<account id>" or "outlook:<account id>"); otherwise whichever mailbox
    # they connected, Outlook only when Gmail is not there.
    use: dict = {}
    use_outlook = False
    try:
        chosen = rows("select value from settings where key = 'primary_mail_account' limit 1")
        kind, _, acct = ((chosen[0].get("value") if chosen else "") or "").partition(":")
        if kind in ("gmail", "outlook") and acct:
            use_outlook, use = kind == "outlook", {"account_id": acct}
        else:
            st = pod.connectors.status()
            on = {str(a.get("connector_id") or "").lower()
                  for a in (st.get("connected_accounts") or st.get("accounts") or [])
                  if isinstance(a, dict) and a.get("status") == "CONNECTED"}
            use_outlook = "outlook" in on and "gmail" not in on
    except Exception:
        pass

    try:
        if use_outlook:
            pod.connectors.execute("outlook", "OUTLOOK_SEND_EMAIL", {
                "to": me, "subject": res.subject, "body": (_own_html(data.html) or _md_to_html(body)),
                "is_html": True, "user_id": "me",
            }, **use)
        else:
            pod.connectors.execute("gmail", "GMAIL_SEND_EMAIL", {
                "recipient_email": me,
                "subject": res.subject,
                "body": (_own_html(data.html) or _md_to_html(body)),
                "is_html": True,
            }, **use)
        res.sent, res.via = True, "mailbox"
        res.reason = "sent"
    except Exception as exc:
        res.errors.append(str(exc)[:250])
        res.reason = "send failed"
        return res

    return _logged(pod, res, me, today)


def _own_html(text: str) -> str:
    """The designed email, without the wrapper escape that only Otto's address needs."""
    t = (text or "").strip()
    if t.startswith("</div>"):
        t = t[len("</div>"):]
    if t.endswith("<div>"):
        t = t[:-len("<div>")]
    return t.strip()


def _logged(pod, res: SendBriefResult, me: str, today: str) -> SendBriefResult:
    try:
        pod.records.create("activity_events", {
            "icon": "mail",
            "what": "Emailed you the morning brief",
            "reason": f"Your one interruption for {today}. Sent to {me}.",
            "happened_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:
        pass          # the mail went; a missing audit line must not fail the run
    return res
