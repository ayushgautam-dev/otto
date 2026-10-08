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


async def find_free_slots(ctx: FunctionContext, data: FindFreeSlotsInput) -> FindFreeSlotsResult:
    pod = Pod.from_env()
    res = FindFreeSlotsResult()
    tz = timezone(timedelta(minutes=data.tz_offset_min))
    now = datetime.now(tz)

    # Never offer a slot in the next couple of hours — it reads as panic.
    search_from = (now + timedelta(hours=2)).replace(minute=0, second=0, microsecond=0)
    search_to = search_from + timedelta(days=max(1, data.days_ahead))

    # Busy time is counted across EVERY calendar the person connected, Google and
    # Outlook alike: a slot that is free on one and taken on the other is not free.
    busy: list[tuple[datetime, datetime]] = []
    t_from = search_from.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_to = search_to.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    targets = [("google", {"account_id": a["id"]}) for a in _my_accounts(pod, ctx, "google_calendar")]
    targets += [("outlook", {"account_id": a["id"]}) for a in _my_accounts(pod, ctx, "outlook")]
    if not targets:      # accounts could not be listed: the workspace default, as before
        targets = [("outlook" if _calendar_is_outlook(pod) else "google", {})]

    for kind, use in targets:
        try:
            if kind == "outlook":
                resp = pod.connectors.execute("outlook", "OUTLOOK_GET_CALENDAR_VIEW", {
                    "start_datetime": t_from, "end_datetime": t_to, "top": 250, "timezone": "UTC",
                }, **use).to_dict()
                r = resp.get("result", resp)
                body = r.get("data", r) if isinstance(r, dict) else {}
                items = body.get("value", []) if isinstance(body, dict) else []
                res.considered_events += len(items)
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
            else:
                resp = pod.connectors.execute("google_calendar", "GOOGLECALENDAR_EVENTS_LIST", {
                    "calendarId": "primary", "timeMin": t_from, "timeMax": t_to,
                    "maxResults": 250, "singleEvents": True, "orderBy": "startTime",
                }, **use).to_dict()
                r = resp.get("result", resp)
                body = r.get("data", r) if isinstance(r, dict) else {}
                items = body.get("items", []) if isinstance(body, dict) else []
                res.considered_events += len(items)
                for ev in items:
                    if (ev.get("status") or "") == "cancelled":
                        continue
                    # Something you declined is not busy time.
                    if any(a.get("self") and a.get("responseStatus") == "declined"
                           for a in (ev.get("attendees") or [])):
                        continue
                    s, e = _parse(ev.get("start")), _parse(ev.get("end"))
                    if s and e:
                        busy.append((s.astimezone(tz), e.astimezone(tz)))
                    if not res.timezone:
                        res.timezone = (ev.get("start") or {}).get("timeZone") or ""
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
