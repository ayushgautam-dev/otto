#input_type_name: ReportInput
#output_type_name: ReportResult
#function_name: first_run_report

"""What to tell somebody once their first run has finished: the email and the short message.

First run reads three weeks of mail, calendar and meeting notes, which can take a good
while, and the person is told they need not wait. So when it is done they are told so, where
they are: a designed email from the assistant's own address, and a short message on WhatsApp
when they talk to it there. This function works out what is true (how much was read, what
was found, what is ready) and lays both out, so the words are the same well-made ones for
everybody and never whatever a model happened to say that day. It sends nothing itself: a
function cannot write as the assistant, so the assistant passes these on.

Called twice by the last step of the `catch_up` workflow:
  * with no `sent`: returns the email and the message, or `skip` when the person has been
    told already (or is being told by another run right now);
  * with `sent`: records which of them went, so it is never said twice.
"""

import html
import json
import re
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

# The morning brief's colours and faces: the two emails should look like one hand made them.
INK, SOFT, FAINT = "#1f1e1c", "#55524c", "#8a867d"
LINE, PAPER, CARD = "#e6e2d9", "#f6f4ee", "#ffffff"
ACCENT, ACCENT_BG = "#b4532a", "#fbf1ea"
# No quoted family names: every style below sits inside a single-quoted attribute.
SANS = "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
SERIF = "Georgia,Times New Roman,serif"
ESCAPE_OPEN, ESCAPE_CLOSE = "</div>", "<div>"
# Another run that began telling them this recently is still at it.
CLAIM_MIN = 20


class ReportInput(BaseModel):
    first_name: str = ""
    assistant_name: str = "Otto"
    sent: list[str] = Field(default_factory=list)   # after sending: "email", "whatsapp"
    again: bool = False                              # lay it out even if already told (never by the workflow)


class Numbers(BaseModel):
    emails: int = 0
    meetings: int = 0
    people: int = 0
    noise: int = 0
    on_you: int = 0            # open, the person's to do
    on_them: int = 0           # open, the person is waiting
    dealt: int = 0             # found, and already settled by something later
    replies: int = 0           # prepared, waiting for a yes
    topics: int = 0


class ReportResult(BaseModel):
    skip: bool = False
    reason: str = ""
    subject: str = ""
    html: str = ""             # the email, finished
    whatsapp: str = ""         # the short message, plain text
    app_url: str = ""
    numbers: Numbers = Field(default_factory=Numbers)
    recorded: bool = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _when(value) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _setting(pod: Pod, key: str) -> dict | None:
    rows = pod.query(
        f"select id, value from settings where key = '{key}' "
        "order by updated_at desc limit 1").to_dict()["items"]
    return rows[0] if rows else None


def _put(pod: Pod, key: str, value: str) -> None:
    row = _setting(pod, key)
    if row:
        pod.table("settings").update(row["id"], {"value": value})
    else:
        pod.table("settings").create({"key": key, "value": value})


def _json(pod: Pod, key: str) -> dict:
    try:
        row = _setting(pod, key)
        out = json.loads(row["value"]) if row else {}
        return out if isinstance(out, dict) else {}
    except Exception:
        return {}


def _e(text: str) -> str:
    return html.escape(" ".join((text or "").split()))


def _url(link: str) -> str:
    link = (link or "").strip()
    return link if re.match(r"^https://[^\s<>\"']+$", link) else ""


def _n(n: int, one: str, many: str = "") -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _span(days: int) -> str:
    weeks = round(days / 7)
    if weeks <= 1:
        return "the last week"
    return f"the last {['', '', 'two', 'three', 'four', 'five', 'six'][weeks] if weeks < 7 else weeks} weeks"


def _count(pod: Pod) -> Numbers:
    row = (pod.query(
        "select"
        " (select count(*) from interactions where kind = 'email') as emails,"
        " (select count(*) from interactions where kind = 'meeting') as meetings,"
        " (select count(*) from people) as people,"
        " (select count(*) from interactions where triage = 'noise'"
        "    or extractor_version in ('noise', 'prefilter')) as noise,"
        " (select count(*) from loops where status = 'open' and side = 'you') as on_you,"
        " (select count(*) from loops where status = 'open' and side = 'them') as on_them,"
        " (select count(*) from loops where close_reason like 'Already dealt with:%') as dealt,"
        " (select count(*) from drafts where status = 'pending') as replies,"
        " (select count(*) from situations where status = 'active') as topics"
    ).to_dict()["items"] or [{}])[0]
    return Numbers(**{k: int(row.get(k) or 0) for k in Numbers.model_fields})


def _first(pod: Pod) -> list[dict]:
    """The three things most worth opening first: the person's own, most pressing first."""
    try:
        return pod.query(
            "select l.obligation, p.name as person, c.name as company "
            "from loops l left join people p on p.id = l.person_id "
            "left join companies c on c.id = p.company_id "
            "where l.status = 'open' and l.side = 'you' and coalesce(l.obligation, '') <> '' "
            "order by coalesce(l.urgency, 0) desc, l.due_at asc nulls last, l.opened_at desc limit 3"
        ).to_dict()["items"]
    except Exception:
        return []


def _did(n: Numbers, span: str) -> list[str]:
    """What was done, as plain sentences. Only what is true: a line with nothing in it is left out."""
    read = [_n(n.emails, "email")] if n.emails else []
    if n.meetings:
        read.append(_n(n.meetings, "meeting"))
    lines = []
    if read:
        aside = f", and set aside {_n(n.noise, 'newsletter or notification', 'newsletters and notifications')}" \
            if n.noise else ""
        lines.append(f"Read {' and '.join(read)} from {span}{aside}.")
    if n.people:
        lines.append(f"Got to know the {_n(n.people, 'person', 'people')} you deal with.")
    found = n.on_you + n.on_them
    if found:
        parts = []
        if n.on_you:
            parts.append(f"{n.on_you} waiting on you")
        if n.on_them:
            parts.append(f"{n.on_them} you are waiting on")
        lines.append(f"Found {_n(found, 'loose end')}: {', '.join(parts)}.")
    if n.dealt:
        lines.append(f"Checked {_n(n.dealt, 'more', 'more')} against what happened later and closed "
                     f"{'it' if n.dealt == 1 else 'them'} as already dealt with.")
    if n.replies:
        lines.append(f"Prepared {_n(n.replies, 'reply', 'replies')}, ready for your yes. Nothing was sent.")
    if n.topics:
        lines.append(f"Sorted it all into {_n(n.topics, 'topic')} so the desk opens in order.")
    return lines


def _who(row: dict) -> str:
    return (row.get("person") or row.get("company") or "").strip()


def _email(name: str, hello: str, n: Numbers, did: list[str], first: list[dict], link: str) -> str:
    def stat(value: int, label: str) -> str:
        return (f"<td width='25%' align='center' style='padding:14px 4px'>"
                f"<div style='font:400 26px {SERIF};color:{INK}'>{value}</div>"
                f"<div style='font:11px {SANS};color:{FAINT};margin-top:2px'>{label}</div></td>")

    def heading(text: str, colour: str = FAINT) -> str:
        return (f"<tr><td style='padding:26px 28px 8px;font:700 11px {SANS};letter-spacing:1.2px;"
                f"text-transform:uppercase;color:{colour}'>{_e(text)}</td></tr>")

    body = [
        f"<tr><td style='padding:30px 28px 0;font:12px {SANS};letter-spacing:1.2px;"
        f"text-transform:uppercase;color:{FAINT}'>{_e(name)} &middot; Ready</td></tr>",
        f"<tr><td style='padding:6px 28px 0;font:400 27px/1.25 {SERIF};color:{INK}'>"
        f"Your chief of staff is set up.</td></tr>",
        f"<tr><td style='padding:8px 28px 0;font:15px/1.5 {SANS};color:{SOFT}'>{_e(hello)} "
        f"I have finished reading, and this is what I did while you were away.</td></tr>",
        f"<tr><td style='padding:18px 28px 0'><table role='presentation' width='100%' cellpadding='0' "
        f"cellspacing='0' style='background:{PAPER};border:1px solid {LINE};border-radius:10px'><tr>"
        + stat(n.emails, "emails read") + stat(n.meetings, "meetings")
        + stat(n.people, "people") + stat(n.on_you + n.on_them, "loose ends")
        + "</tr></table></td></tr>",
    ]
    if did:
        rows = "".join(
            f"<tr><td width='18' valign='top' style='padding:7px 0;font:14px {SANS};color:{ACCENT}'>&#10003;</td>"
            f"<td style='padding:7px 0;font:14px/1.5 {SANS};color:{SOFT}'>{_e(line)}</td></tr>" for line in did)
        body.append(heading("What I did"))
        body.append(f"<tr><td style='padding:0 28px'><table role='presentation' width='100%' cellpadding='0' "
                    f"cellspacing='0'>{rows}</table></td></tr>")
    if first:
        cards = "".join(
            f"<tr><td style='padding:12px 16px;{'border-top:1px solid #f1dccd;' if i else ''}'>"
            + (f"<div style='font:600 14px {SANS};color:{INK}'>{_e(_who(row))}</div>" if _who(row) else "")
            + f"<div style='font:14px/1.5 {SANS};color:{SOFT};margin-top:2px'>{_e(row.get('obligation') or '')}</div>"
            f"</td></tr>" for i, row in enumerate(first))
        body.append(heading("Worth opening first", ACCENT))
        body.append(
            f"<tr><td style='padding:0 28px'><table role='presentation' width='100%' cellpadding='0' "
            f"cellspacing='0' style='background:{ACCENT_BG};border:1px solid #f1dccd;border-radius:10px'>"
            f"{cards}</table></td></tr>")
    elif not (n.on_you + n.on_them):
        body.append(f"<tr><td style='padding:18px 28px 0;font:14px/1.5 {SANS};color:{SOFT}'>"
                    f"Nothing is waiting on you right now. I will keep watching as mail arrives.</td></tr>")
    if link:
        body.append(
            f"<tr><td style='padding:26px 28px 0'><a href='{html.escape(link, quote=True)}' "
            f"style='display:inline-block;background:{INK};color:#ffffff;font:600 15px {SANS};"
            f"text-decoration:none;border-radius:10px;padding:13px 22px'>Open your desk &rarr;</a></td></tr>")
    body.append(
        f"<tr><td style='padding:26px 28px 0'><table role='presentation' width='100%' cellpadding='0' "
        f"cellspacing='0'><tr><td style='border-top:1px solid {LINE};padding:16px 0 28px;"
        f"font:13px/1.6 {SANS};color:{FAINT}'>From here I read new mail as it arrives and keep this "
        f"up to date. <b style='color:{SOFT}'>Reply to this email</b> any time to ask me something or "
        f"hand me work: &ldquo;what am I waiting on?&rdquo;, &ldquo;draft a reply to the first one&rdquo;."
        f"</td></tr></table></td></tr>")
    # Same wrapper as the morning brief: the assistant's own address puts whatever it is given
    # in a narrow box pinned left, so that box is closed first and an empty one reopened after.
    return (
        f"{ESCAPE_OPEN}<table role='presentation' width='100%' cellpadding='0' cellspacing='0' "
        f"style='background:{PAPER}'><tr><td align='center' style='padding:24px 10px'>"
        f"<table role='presentation' width='100%' cellpadding='0' cellspacing='0' "
        f"style='max-width:600px;background:{CARD};border:1px solid {LINE};border-radius:14px;text-align:left'>"
        + "".join(body) + f"</table></td></tr></table>{ESCAPE_CLOSE}")


def _whatsapp(name: str, first_name: str, n: Numbers, span: str, first: list[dict], link: str) -> str:
    hi = f"Hi {first_name}, {name} here." if first_name else f"Hi, {name} here."
    out = [f"{hi} I have finished reading, so your desk is ready."]
    read = [_n(n.emails, "email")] if n.emails else []
    if n.meetings:
        read.append(_n(n.meetings, "meeting"))
    found = n.on_you + n.on_them
    line = f"I read {' and '.join(read)} from {span}" if read else f"I went through {span}"
    if found:
        parts = ([f"{n.on_you} waiting on you"] if n.on_you else []) + \
                ([f"{n.on_them} you are waiting on"] if n.on_them else [])
        line += f" and found {_n(found, 'loose end')}: {', '.join(parts)}."
    else:
        line += ". Nothing is waiting on you right now."
    if n.replies:
        line += f" I also prepared {_n(n.replies, 'reply', 'replies')} for you to approve."
    out.append(line)
    if first:
        out.append("First up:\n" + "\n".join(
            f"• {(_who(r) + ': ') if _who(r) else ''}{' '.join((r.get('obligation') or '').split())}" for r in first))
    if link:
        out.append(f"Open your desk: {link}")
    out.append("Or ask me here any time, for example \"what is waiting on me?\"")
    return "\n\n".join(out)


async def first_run_report(ctx: FunctionContext, data: ReportInput) -> ReportResult:
    pod = ctx.pod or Pod.from_env()
    res = ReportResult()
    told = _json(pod, "first_run_told")

    if data.sent:
        told.update({"sent": sorted({s.strip().lower() for s in data.sent if s.strip()}),
                     "at": _now().isoformat()})
        told.pop("claimed_at", None)
        _put(pod, "first_run_told", json.dumps(told))
        res.recorded = True
        return res

    if not data.again:
        if told.get("at"):
            res.skip, res.reason = True, "already told"
            return res
        claimed = _when(told.get("claimed_at"))
        if claimed and _now() - claimed < timedelta(minutes=CLAIM_MIN):
            res.skip, res.reason = True, "another run is telling them now"
            return res
        state = _json(pod, "catchup")
        if not state.get("done"):
            res.skip, res.reason = True, "first run has not finished"
            return res
        _put(pod, "first_run_told", json.dumps({"claimed_at": _now().isoformat()}))

    n = res.numbers = _count(pod)
    span = _span(int(_json(pod, "catchup").get("target") or 21))
    name = (data.assistant_name or "").strip() or "Otto"
    first_name = (data.first_name or "").strip().split(" ")[0]
    link = res.app_url = _url((_setting(pod, "app_url") or {}).get("value") or "")
    first = _first(pod)
    found = n.on_you + n.on_them

    res.subject = (f"{name} is ready: {_n(found, 'loose end')} found" if found
                   else f"{name} is ready")
    res.html = _email(name, f"Hi {first_name}." if first_name else "Hi.", n, _did(n, span), first, link)
    res.whatsapp = _whatsapp(name, first_name, n, span, first, link)
    return res
