#input_type_name: RenderBriefInput
#output_type_name: RenderBriefResult

#function_name: render_brief

import html
import re

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext

# Turns the morning brief into the email the person actually opens.
#
# The assistant decides what the brief says; this decides what it looks like, so the
# brief is the same well-made email every morning and for every person, instead of
# whatever a model happened to format that day. It reads nothing and sends nothing:
# facts in, HTML out.
#
# Written for mail clients, which means tables and inline styles only. No stylesheet,
# no web fonts, no images, nothing that a client strips. Colours are the app's own.

INK, SOFT, FAINT = "#1f1e1c", "#55524c", "#8a867d"
LINE, PAPER, CARD = "#e6e2d9", "#f6f4ee", "#ffffff"
ACCENT, ACCENT_BG = "#b4532a", "#fbf1ea"
LATE, LATE_BG = "#a4372b", "#fbecea"
# No quoted family names: every style below sits inside a single-quoted attribute.
SANS = "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
SERIF = "Georgia,Times New Roman,serif"


class Item(BaseModel):
    who: str = ""              # the person or company, as the person knows them
    what: str = ""             # the thing itself, one plain sentence
    tag: str = ""              # optional short label: "7 days late", "drafted", "due Fri"


class Meeting(BaseModel):
    time: str = ""             # "10:30" or "10:30–10:50", the person's own clock
    title: str = ""
    link: str = ""             # the join link, when there is one
    people: str = ""           # who is coming, as a short phrase
    owed: list[str] = Field(default_factory=list)   # what is outstanding with them; empty = nothing


class RenderBriefInput(BaseModel):
    day: str                                   # "Monday 12 October"
    first_name: str = ""
    needs_you: list[Item] = Field(default_factory=list)     # at most three
    meetings: list[Meeting] = Field(default_factory=list)   # today
    tomorrow: list[Meeting] = Field(default_factory=list)
    ready: list[Item] = Field(default_factory=list)         # drafted, waiting for a yes
    waiting: list[Item] = Field(default_factory=list)       # open on the person's side
    overdue: list[Item] = Field(default_factory=list)       # oldest first
    assistant_name: str = "Otto"


class RenderBriefResult(BaseModel):
    html: str = ""
    summary: str = ""          # "2 meetings, 1 overdue, 3 ready to send" for the subject line
    error: str = ""


def _e(text: str) -> str:
    """Escaped text, with **bold** kept."""
    out = html.escape(" ".join((text or "").split()))
    return re.sub(r"\*\*(.+?)\*\*", rf"<b style='color:{INK}'>\1</b>", out)


def _url(link: str) -> str:
    link = (link or "").strip()
    return html.escape(link, quote=True) if re.match(r"^https://[^\s<>\"']+$", link) else ""


def _pill(text: str, fg: str, bg: str) -> str:
    return (f"<span style='display:inline-block;font:600 11px {SANS};color:{fg};background:{bg};"
            f"border-radius:10px;padding:2px 8px;margin-left:6px;white-space:nowrap'>{_e(text)}</span>")


def _heading(text: str, count: int = 0, colour: str = FAINT) -> str:
    n = f" <span style='color:{FAINT};font-weight:400'>{count}</span>" if count else ""
    return (f"<tr><td style='padding:26px 28px 8px;font:700 11px {SANS};letter-spacing:1.2px;"
            f"text-transform:uppercase;color:{colour}'>{_e(text)}{n}</td></tr>")


def _items(items: list[Item], fg: str = ACCENT, bg: str = ACCENT_BG) -> str:
    rows = []
    for i, it in enumerate(items):
        top = f"border-top:1px solid {LINE};" if i else ""
        tag = _pill(it.tag, fg, bg) if it.tag.strip() else ""
        who = f"<div style='font:600 14px {SANS};color:{INK}'>{_e(it.who)}{tag}</div>" if it.who.strip() else ""
        rows.append(
            f"<tr><td style='padding:11px 0;{top}'>{who}"
            f"<div style='font:14px/1.5 {SANS};color:{SOFT};margin-top:2px'>{_e(it.what)}</div></td></tr>")
    return (f"<tr><td style='padding:0 28px'><table role='presentation' width='100%' cellpadding='0' "
            f"cellspacing='0'>{''.join(rows)}</table></td></tr>")


def _meetings(meetings: list[Meeting]) -> str:
    rows = []
    for i, m in enumerate(meetings):
        top = f"border-top:1px solid {LINE};" if i else ""
        link = _url(m.link)
        join = (f" <a href='{link}' style='font:600 12px {SANS};color:{ACCENT};text-decoration:none;"
                f"white-space:nowrap'>Join &rarr;</a>") if link else ""
        people = f"<div style='font:13px/1.5 {SANS};color:{FAINT};margin-top:2px'>{_e(m.people)}</div>" \
            if m.people.strip() else ""
        owed = [o for o in m.owed if o.strip()]
        if owed:
            lines = "".join(
                f"<div style='font:13px/1.5 {SANS};color:{INK};margin-top:6px;padding:7px 10px;"
                f"background:{ACCENT_BG};border-left:3px solid {ACCENT};border-radius:0 6px 6px 0'>"
                f"{_e(o)}</div>" for o in owed)
        else:
            lines = f"<div style='font:13px {SANS};color:{FAINT};margin-top:4px'>Nothing outstanding.</div>"
        rows.append(
            f"<tr><td width='92' valign='top' style='padding:13px 0;{top}font:600 13px {SANS};"
            f"color:{INK};white-space:nowrap'>{_e(m.time)}</td>"
            f"<td valign='top' style='padding:13px 0;{top}'>"
            f"<div style='font:600 15px/1.4 {SANS};color:{INK}'>{_e(m.title)}{join}</div>"
            f"{people}{lines}</td></tr>")
    return (f"<tr><td style='padding:0 28px'><table role='presentation' width='100%' cellpadding='0' "
            f"cellspacing='0'>{''.join(rows)}</table></td></tr>")


def _plural(n: int, one: str, many: str = "") -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


async def render_brief(ctx: FunctionContext, data: RenderBriefInput) -> RenderBriefResult:
    res = RenderBriefResult()
    if not (data.day or "").strip():
        res.error = "say which day the brief is for"
        return res
    needs = data.needs_you[:3]

    counts = []
    if data.meetings:
        counts.append(_plural(len(data.meetings), "meeting"))
    if data.overdue:
        counts.append(f"{len(data.overdue)} overdue")
    if data.ready:
        counts.append(f"{len(data.ready)} ready to send")
    if data.waiting:
        counts.append(f"{len(data.waiting)} waiting on you")
    res.summary = ", ".join(counts) or "nothing waiting on you"

    hello = f"Good morning, {_e(data.first_name)}." if data.first_name.strip() else "Good morning."
    body = [
        f"<tr><td style='padding:30px 28px 0;font:12px {SANS};letter-spacing:1.2px;"
        f"text-transform:uppercase;color:{FAINT}'>{_e(data.assistant_name)} &middot; Morning brief</td></tr>",
        f"<tr><td style='padding:6px 28px 0;font:400 27px/1.25 {SERIF};color:{INK}'>{_e(data.day)}</td></tr>",
        f"<tr><td style='padding:8px 28px 0;font:15px/1.5 {SANS};color:{SOFT}'>{hello} "
        f"{_e(res.summary[:1].upper() + res.summary[1:])}.</td></tr>",
    ]

    if needs:
        cards = "".join(
            f"<tr><td style='padding:12px 16px;{'border-top:1px solid #f1dccd;' if i else ''}'>"
            f"<div style='font:600 14px {SANS};color:{INK}'>{_e(it.who)}"
            f"{_pill(it.tag, ACCENT, CARD) if it.tag.strip() else ''}</div>"
            f"<div style='font:14px/1.5 {SANS};color:{SOFT};margin-top:2px'>{_e(it.what)}</div></td></tr>"
            for i, it in enumerate(needs))
        body.append(_heading("Needs you today", colour=ACCENT))
        body.append(
            f"<tr><td style='padding:0 28px'><table role='presentation' width='100%' cellpadding='0' "
            f"cellspacing='0' style='background:{ACCENT_BG};border:1px solid #f1dccd;border-radius:10px'>"
            f"{cards}</table></td></tr>")

    body.append(_heading("Today", len(data.meetings)))
    if data.meetings:
        body.append(_meetings(data.meetings))
    else:
        body.append(f"<tr><td style='padding:4px 28px 0;font:14px {SANS};color:{SOFT}'>"
                    "No meetings today.</td></tr>")

    if data.ready:
        body.append(_heading("Ready to send", len(data.ready)))
        body.append(_items(data.ready))
    if data.waiting:
        body.append(_heading("Waiting on you", len(data.waiting)))
        body.append(_items(data.waiting))
    if data.overdue:
        body.append(_heading("Overdue", len(data.overdue), LATE))
        body.append(_items(data.overdue, LATE, LATE_BG))
    if data.tomorrow:
        body.append(_heading("Tomorrow", len(data.tomorrow)))
        body.append(_meetings(data.tomorrow))

    body.append(
        f"<tr><td style='padding:26px 28px 0'><table role='presentation' width='100%' cellpadding='0' "
        f"cellspacing='0'><tr><td style='border-top:1px solid {LINE};padding:16px 0 28px;"
        f"font:13px/1.6 {SANS};color:{FAINT}'><b style='color:{SOFT}'>Reply to this email</b> to act on "
        f"anything above: &ldquo;send the first draft&rdquo;, &ldquo;move the 3pm to tomorrow&rdquo;. "
        f"Nothing else will interrupt you today.</td></tr></table></td></tr>")

    res.html = (
        f"<table role='presentation' width='100%' cellpadding='0' cellspacing='0' "
        f"style='background:{PAPER}'><tr><td align='center' style='padding:24px 10px'>"
        f"<table role='presentation' width='100%' cellpadding='0' cellspacing='0' "
        f"style='max-width:600px;background:{CARD};border:1px solid {LINE};border-radius:14px;text-align:left'>"
        + "".join(body) + "</table></td></tr></table>")
    return res
