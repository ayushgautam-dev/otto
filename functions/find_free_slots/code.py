#input_type_name: FindFreeSlotsInput
#output_type_name: FindFreeSlotsResult
#function_name: find_free_slots

# Free slots from the founder's own calendar, phrased the way a person would offer
# them in an email ("Tue 2 Sep, 3:00–3:30 PM IST").
#
# This exists so the composer can offer real times instead of "let me know what
# works" — which is the sentence that keeps a scheduling loop open for a week.
# Read-only: it never creates, moves or holds an event.

from datetime import datetime, timedelta, timezone
from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod


class FindFreeSlotsInput(BaseModel):
    days_ahead: int = 10          # how far out to look
    duration_min: int = 30        # length of the meeting being offered
    count: int = 3                # how many options to return
    work_start_hour: int = 10     # local working day, 24h
    work_end_hour: int = 18
    tz_offset_min: int = 330      # default IST; the calendar's own tz wins when known


class Slot(BaseModel):
    start: str
    end: str
    label: str


class FindFreeSlotsResult(BaseModel):
    slots: list[Slot] = []
    timezone: str = ""
    considered_events: int = 0
    errors: list[str] = []


def _parse(dt: dict) -> datetime | None:
    """Google gives either dateTime (timed) or date (all-day)."""
    raw = (dt or {}).get("dateTime") or (dt or {}).get("date")
    if not raw:
        return None
    try:
        if len(raw) == 10:  # all-day
            return datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None


def _calendar_is_outlook(pod) -> bool:
    """The Outlook calendar is the person's calendar when Outlook is connected and Google
    Calendar is not."""
    try:
        st = pod.connectors.status()
        on = {str(a.get("connector_id") or "").lower()
              for a in (st.get("connected_accounts") or st.get("accounts") or [])
              if isinstance(a, dict) and a.get("status") == "CONNECTED"}
        return "outlook" in on and "google_calendar" not in on
    except Exception:
        return False


async def find_free_slots(ctx: FunctionContext, data: FindFreeSlotsInput) -> FindFreeSlotsResult:
    pod = Pod.from_env()
    res = FindFreeSlotsResult()
    tz = timezone(timedelta(minutes=data.tz_offset_min))
    now = datetime.now(tz)

    # Never offer a slot in the next couple of hours — it reads as panic.
    search_from = (now + timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)
    search_to = search_from + timedelta(days=max(1, data.days_ahead))

    busy: list[tuple[datetime, datetime]] = []
    outlook = _calendar_is_outlook(pod)
    if outlook:
        try:
            resp = pod.connectors.execute("outlook", "OUTLOOK_GET_CALENDAR_VIEW", {
                "start_datetime": search_from.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end_datetime": search_to.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "top": 250, "timezone": "UTC",
            }).to_dict()
            r = resp.get("result", resp)
            body = r.get("data", r) if isinstance(r, dict) else {}
            items = body.get("value", []) if isinstance(body, dict) else []
            res.considered_events = len(items)
            for ev in items:
                # cancelled, declined, or marked free: none of those is busy time
                if ev.get("isCancelled") or (ev.get("showAs") or "") == "free":
                    continue
                if ((ev.get("responseStatus") or {}).get("response") or "") == "declined":
                    continue
                try:
                    s0 = datetime.fromisoformat(((ev.get("start") or {}).get("dateTime") or "")[:19]).replace(tzinfo=timezone.utc)
                    e0 = datetime.fromisoformat(((ev.get("end") or {}).get("dateTime") or "")[:19]).replace(tzinfo=timezone.utc)
                except Exception:
                    continue
                busy.append((s0.astimezone(tz), e0.astimezone(tz)))
        except Exception as exc:
            res.errors.append(str(exc)[:200])
    try:
        if outlook:
            raise StopIteration
        resp = pod.connectors.execute("google_calendar", "GOOGLECALENDAR_EVENTS_LIST", {
            "calendarId": "primary",
            "timeMin": search_from.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "timeMax": search_to.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "maxResults": 250, "singleEvents": True, "orderBy": "startTime",
        }).to_dict()
        r = resp.get("result", resp)
        body = r.get("data", r) if isinstance(r, dict) else {}
        items = body.get("items", []) if isinstance(body, dict) else []
        res.considered_events = len(items)
        for ev in items:
            if (ev.get("status") or "") == "cancelled":
                continue
            # Something you declined is not busy time.
            declined = any(
                a.get("self") and a.get("responseStatus") == "declined"
                for a in (ev.get("attendees") or [])
            )
            if declined:
                continue
            s, e = _parse(ev.get("start")), _parse(ev.get("end"))
            if s and e:
                busy.append((s.astimezone(tz), e.astimezone(tz)))
            if not res.timezone:
                res.timezone = (ev.get("start") or {}).get("timeZone") or ""
    except StopIteration:
        pass
    except Exception as exc:
        # No calendar is a soft failure — the composer just offers nothing specific.
        res.errors.append(str(exc)[:200])

    step = timedelta(minutes=30)
    dur = timedelta(minutes=max(15, data.duration_min))
    cursor = search_from
    while cursor < search_to and len(res.slots) < max(1, data.count):
        end = cursor + dur
        in_hours = (
            cursor.weekday() < 5
            and cursor.hour >= data.work_start_hour
            and end.hour <= data.work_end_hour
            and end.date() == cursor.date()
        )
        if in_hours and not any(s < end and cursor < e for s, e in busy):
            res.slots.append(Slot(
                start=cursor.isoformat(),
                end=end.isoformat(),
                label=(
                    f"{cursor.strftime('%a %-d %b')}, "
                    f"{cursor.strftime('%-I:%M')}–{end.strftime('%-I:%M %p')}"
                ),
            ))
            # Spread the options across different days where possible.
            cursor = (cursor + timedelta(days=1)).replace(
                hour=data.work_start_hour, minute=0, second=0, microsecond=0)
            continue
        cursor += step

    if not res.timezone:
        res.timezone = f"UTC{data.tz_offset_min // 60:+d}"
    return res
