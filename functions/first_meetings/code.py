#input_type_name: FirstInput
#output_type_name: FirstResult
#function_name: first_meetings

"""Meetings coming up with somebody the person has not really met yet.

Before a recurring meeting the person already gets "what to raise". Before a FIRST
meeting they got nothing, and that is the one where a few lines on who is about to walk
in help most. This finds those meetings; an agent step then writes the short brief onto
the person's record (`people.research`), where the desk and the morning brief read it.

Somebody counts as new when ALL of these hold:
  * they are outside the person's own company (and not on a personal copy of it);
  * the meeting is a one-off, not an occurrence of a recurring series;
  * no earlier meeting with them is on the calendar;
  * hardly any mail has gone between them: at most a few messages, the ones that set
    this meeting up;
  * no brief has been written for them already.

Large gatherings (a webinar, an all-hands with guests) are left out: a brief on forty
attendees helps nobody. Nothing is decided about a person here beyond "new or not".
"""

from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
    "yahoo.co.in", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
    "gmx.com", "mail.com", "zoho.com", "rediffmail.com", "fastmail.com", "hey.com",
}
MAX_GUESTS = 4          # more outside guests than this is a gathering, not a first meeting
MAX_MAIL = 6            # messages either way that still count as "has not really met"


class FirstInput(BaseModel):
    hours: int = 48
    # for one named meeting (its row id), whatever its date: used when the person asks
    meeting_id: str | None = None


class Guest(BaseModel):
    email: str
    name: str = ""
    company_domain: str = ""
    person_id: str | None = None
    role: str | None = None
    mail_between: int = 0       # messages either way so far


class Meeting(BaseModel):
    meeting_id: str
    title: str = ""
    when: str | None = None
    guests: list[Guest] = Field(default_factory=list)


class FirstResult(BaseModel):
    any: bool = False
    meetings: list[Meeting] = Field(default_factory=list)
    # a paid lookup key is saved: research_person can be used for a fuller profile
    has_key: bool = False


def _emails(parts, role: str | None = None) -> list[str]:
    out = []
    for p in (parts if isinstance(parts, list) else []):
        if not isinstance(p, dict) or (role and p.get("role") != role):
            continue
        e = (p.get("email") or "").strip().lower()
        if e:
            out.append(e)
    return out


async def first_meetings(ctx: FunctionContext, data: FirstInput) -> FirstResult:
    pod = ctx.pod or Pod.from_env()
    res = FirstResult()
    now = datetime.now(timezone.utc)

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    try:
        key = rows("select value from settings where key = 'research_api_key' order by updated_at desc limit 1")
        res.has_key = bool(key and (key[0].get("value") or "").strip())
    except Exception:
        res.has_key = False

    if data.meeting_id:
        safe = "".join(c for c in data.meeting_id if c.isalnum() or c == "-")
        upcoming = rows(
            "select id, external_id, thread_ref, occurred_at, subject, participants from interactions "
            f"where id = '{safe}' and source = 'calendar'")
    else:
        until = now + timedelta(hours=max(1, min(24 * 7, data.hours)))
        upcoming = rows(
            "select id, external_id, thread_ref, occurred_at, subject, participants from interactions "
            f"where source = 'calendar' and occurred_at > '{now.isoformat()}' "
            f"and occurred_at < '{until.isoformat()}' order by occurred_at asc limit 60")
    if not upcoming:
        return res

    # who I am: every address I have written from, and my company's domain
    mine = {(getattr(ctx, "user_email", "") or "").strip().lower()}
    sent = rows("select participants from interactions where direction = 'outbound' "
                "order by occurred_at desc limit 400")
    for r in sent:
        mine.update(_emails(r.get("participants"), "from"))
    mine.discard("")
    team = {m.split("@")[-1] for m in mine if "@" in m} - FREE_MAIL

    people = {(r.get("email") or "").lower(): r for r in rows(
        "select id, email, name, role, research from people where email is not null")}

    # everything on the calendar before now, to know who has been met already
    met: set[str] = set()
    for r in rows("select participants from interactions where source = 'calendar' "
                  f"and occurred_at < '{now.isoformat()}' order by occurred_at desc limit 1500"):
        met.update(_emails(r.get("participants")))

    def mail_between(email: str) -> int:
        safe = email.replace("'", "''").replace("%", "")
        got = rows("select count(*) as n from interactions where kind = 'email' "
                   f"and participants::text ilike '%{safe}%'")
        return int((got[0] or {}).get("n") or 0) if got else 0

    for ev in upcoming:
        ext = ev.get("external_id") or ""
        ref = ev.get("thread_ref") or ""
        one_off = ref == ext or ref == "" or ref.split(":", 1)[-1] == ext.split(":", 1)[-1]
        if not one_off and not data.meeting_id:
            continue
        outside = [e for e in _emails(ev.get("participants"))
                   if e not in mine and e.split("@")[-1] not in team]
        if not outside or len(outside) > MAX_GUESTS:
            continue
        guests = []
        for e in outside:
            known = people.get(e) or {}
            if (known.get("research") or "").strip() and not data.meeting_id:
                continue                    # already briefed on them
            if e in met and not data.meeting_id:
                continue                    # met before
            n = mail_between(e)
            if n > MAX_MAIL and not data.meeting_id:
                continue                    # they already correspond: not a stranger
            dom = e.split("@")[-1]
            name = known.get("name") or next(
                (p.get("name") or "" for p in (ev.get("participants") or [])
                 if isinstance(p, dict) and (p.get("email") or "").lower() == e), "")
            guests.append(Guest(
                email=e, name=name, company_domain="" if dom in FREE_MAIL else dom,
                person_id=str(known["id"]) if known.get("id") else None,
                role=known.get("role"), mail_between=n))
        if guests:
            res.meetings.append(Meeting(
                meeting_id=str(ev["id"]), title=ev.get("subject") or "",
                when=str(ev.get("occurred_at") or "") or None, guests=guests))
    res.any = bool(res.meetings)
    return res
