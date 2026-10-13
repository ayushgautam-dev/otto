#input_type_name: FetchCalendarInput
#output_type_name: FetchCalendarResult
#function_name: fetch_calendar_events

# Deterministic Google Calendar pull. Returns a compact digest of recent + upcoming
# events (title, times, attendees, recurrence, meet link) plus recurring-series groups
# that are candidate Work projects. No judgment here — fetch + shape.

import re
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod


class FetchCalendarInput(BaseModel):
    past_days: int = 30
    future_days: int = 14
    max_events: int = 120


class Attendee(BaseModel):
    email: str
    name: str = ""


class EventOut(BaseModel):
    id: str
    title: str
    start: str
    end: str
    is_past: bool
    is_recurring: bool
    recurring_id: str = ""
    attendees: list[Attendee] = Field(default_factory=list)
    meet_link: str = ""


class SeriesOut(BaseModel):
    title: str
    occurrences: int
    attendees: list[str]
    last_at: str
    cadence: str


class FetchCalendarResult(BaseModel):
    my_email: str
    event_count: int
    events: list[EventOut]
    recurring_series: list[SeriesOut]


def _name_from(email: str) -> str:
    local = email.split("@")[0]
    return re.sub(r"[._]+", " ", local).title()


# Calendars Google adds for everybody, which hold no meetings of the person's own.
_NOT_MEETINGS = ("#holiday@", "#contacts@", "#weeknum@", "#birthday@", "addressbook#")

_CALL_LINK = re.compile(
    r"https://(?:[\w-]+\.)?(?:zoom\.us/(?:j|my|w|s)/|teams\.microsoft\.com/l/meetup-join/|teams\.microsoft\.com/meet/|"
    r"teams\.live\.com/meet/|meet\.google\.com/|webex\.com/|whereby\.com/|gotomeet\.me/|gotomeeting\.com/join/|"
    r"bluejeans\.com/|chime\.aws/|around\.co/|meet\.jit\.si/|cal\.com/video/|riverside\.fm/studio/)[^\s\"'<>)\]]*",
    re.I)


def _call_link(ev: dict) -> str:
    """Where to join, whoever hosts the call: Meet, Zoom, Teams, Webex and the like."""
    if ev.get("hangoutLink"):
        return ev["hangoutLink"]
    for point in ((ev.get("conferenceData") or {}).get("entryPoints") or []):
        if (point.get("entryPointType") == "video") and point.get("uri"):
            return point["uri"]
    for text in (ev.get("location") or "", ev.get("description") or ""):
        found = _CALL_LINK.search(text)
        if found:
            return found.group(0).rstrip(".,;")
    return ""


def _unwrap(resp) -> dict:
    resp = resp.to_dict() if hasattr(resp, "to_dict") else resp
    r = resp.get("result", resp) if isinstance(resp, dict) else {}
    d = r.get("data", r) if isinstance(r, dict) else {}
    return d if isinstance(d, dict) else {}


def _my_calendars(pod, use: dict) -> list[dict]:
    """The calendars the person keeps switched on in Google Calendar: [{id, name, primary}].
    If they cannot be listed, the main calendar alone, as before."""
    try:
        body = _unwrap(pod.connectors.execute("google_calendar", "GOOGLECALENDAR_LIST_CALENDARS", {}, **use))
        got = body.get("calendars") or body.get("items") or []
    except Exception:
        got = []
    out = []
    for c in got:
        cid = str(c.get("id") or "")
        if not cid or c.get("deleted") or c.get("hidden"):
            continue
        if any(mark in cid for mark in _NOT_MEETINGS):
            continue
        # ticked in their calendar list, or their own: what they see when they look
        if not (c.get("primary") or c.get("selected")):
            continue
        out.append({"id": cid, "name": (c.get("summaryOverride") or c.get("summary") or "").strip(),
                    "primary": bool(c.get("primary"))})
    out.sort(key=lambda c: not c["primary"])
    return out[:12] or [{"id": "primary", "name": "", "primary": True}]


async def fetch_calendar_events(ctx: FunctionContext, data: FetchCalendarInput) -> FetchCalendarResult:
    pod = Pod.from_env()
    me = (ctx.user_email or "").lower()
    now = datetime.now(timezone.utc)
    tmin = (now - timedelta(days=data.past_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    tmax = (now + timedelta(days=data.future_days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # every calendar the person keeps switched on, not only the main one (see sync_calendar)
    items: list[dict] = []
    seen: set[str] = set()
    for cal in _my_calendars(pod, {}):
        try:
            body = _unwrap(pod.connectors.execute("google_calendar", "GOOGLECALENDAR_EVENTS_LIST", {
                "calendarId": cal["id"], "timeMin": tmin, "timeMax": tmax,
                "maxResults": data.max_events, "singleEvents": True, "orderBy": "startTime",
            }))
        except Exception:
            if cal["primary"]:
                raise
            continue
        for ev in body.get("items") or []:
            if ev.get("id") and ev["id"] not in seen:
                seen.add(ev["id"])
                items.append(ev)
    items.sort(key=lambda ev: (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date") or "")

    events: list[EventOut] = []
    series: dict[str, dict] = defaultdict(lambda: {"title": "", "occ": 0, "att": set(), "last": ""})
    for ev in items:
        if ev.get("status") == "cancelled":
            continue
        start = (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date") or ""
        end = (ev.get("end") or {}).get("dateTime") or (ev.get("end") or {}).get("date") or ""
        atts = []
        for a in (ev.get("attendees") or []):
            em = (a.get("email") or "").lower()
            if not em or em == me or a.get("resource"):
                continue
            atts.append(Attendee(email=em, name=a.get("displayName") or _name_from(em)))
        rec_id = ev.get("recurringEventId") or ""
        title = (ev.get("summary") or "(untitled)").strip()
        is_past = start[:10] < now.strftime("%Y-%m-%d") if start else False
        events.append(EventOut(
            id=ev.get("id", ""), title=title, start=start, end=end, is_past=is_past,
            is_recurring=bool(rec_id), recurring_id=rec_id, attendees=atts,
            meet_link=_call_link(ev),
        ))
        # group recurring series by title (stable attendee set → Work project candidate)
        if rec_id or True:
            key = title.lower()
            s = series[key]
            s["title"] = title
            s["occ"] += 1
            for a in atts:
                s["att"].add(a.email)
            if start > s["last"]:
                s["last"] = start

    recurring = []
    for s in series.values():
        if s["occ"] >= 2 and s["att"]:            # repeats, with a stable other-party set
            recurring.append(SeriesOut(
                title=s["title"], occurrences=s["occ"], attendees=sorted(s["att"])[:8],
                last_at=s["last"], cadence="weekly" if s["occ"] >= 3 else "recurring",
            ))

    return FetchCalendarResult(
        my_email=me, event_count=len(events), events=events[: data.max_events],
        recurring_series=recurring,
    )
