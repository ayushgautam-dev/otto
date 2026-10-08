#input_type_name: SendInviteInput
#output_type_name: SendInviteResult

#function_name: send_invite

import re
from datetime import datetime

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

# The meeting card's "Send invite". Like send_draft, this is only ever triggered by the
# person's own click, and it reports failure honestly instead of pretending. It books one
# event on their primary calendar with a Meet link and emails the invite to the guests.
# The app passes everything it shows on screen — an app-invoked function cannot read the
# person's RLS rows — and does its own bookkeeping after a success.


class SendInviteInput(BaseModel):
    title: str
    start: str                    # local wall-clock time, "YYYY-MM-DDTHH:MM" (seconds optional)
    duration_min: int = 30
    timezone: str = "Asia/Kolkata"
    attendees: list[str] = []
    description: str | None = None
    # which calendar the invite goes on, when the person has more than one:
    # the connected account's id, and "google" or "outlook"
    account_id: str | None = None
    provider: str | None = None


class SendInviteResult(BaseModel):
    sent: bool = False
    event_id: str = ""
    link: str = ""
    error: str = ""


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


async def send_invite(ctx: FunctionContext, data: SendInviteInput) -> SendInviteResult:
    pod = Pod.from_env()
    res = SendInviteResult()

    guests = []
    for a in data.attendees:
        a = (a or "").strip().lower()
        if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", a) and a not in guests:
            guests.append(a)
    if not guests:
        res.error = "nobody to invite"
        return res

    raw = data.start.strip().replace("Z", "")
    raw = re.sub(r"[+-]\d\d:\d\d$", "", raw)
    try:
        start = datetime.fromisoformat(raw)
    except ValueError:
        res.error = f"could not read the start time '{data.start}'"
        return res

    mins = max(5, min(int(data.duration_min or 30), 8 * 60))
    use = {"account_id": data.account_id} if (data.account_id or "").strip() else {}
    provider = (data.provider or "").strip().lower()
    if provider == "outlook" or (not provider and _calendar_is_outlook(pod)):
        from datetime import timedelta
        o_args = {
            "subject": data.title.strip() or "Meeting",
            "start_datetime": start.strftime("%Y-%m-%dT%H:%M:%S"),
            "end_datetime": (start + timedelta(minutes=mins)).strftime("%Y-%m-%dT%H:%M:%S"),
            "time_zone": data.timezone or "UTC",
            "attendees_info": guests,
            "is_online_meeting": True,
            "user_id": "me",
        }
        if data.description:
            o_args["body"] = data.description
        try:
            out = pod.connectors.execute("outlook", "OUTLOOK_CALENDAR_CREATE_EVENT", o_args, **use)
            out = out.to_dict() if hasattr(out, "to_dict") else out
        except Exception as exc:
            res.error = f"Calendar refused the invite: {str(exc)[:200]}"
            return res
        r = out.get("result", out) if isinstance(out, dict) else {}
        ev = r.get("data", r) if isinstance(r, dict) else {}
        res.sent = True
        res.event_id = str((ev or {}).get("id") or "")
        res.link = str(((ev or {}).get("onlineMeeting") or {}).get("joinUrl") or (ev or {}).get("webLink") or "")
        return res
    args = {
        "calendar_id": "primary",
        "summary": data.title.strip() or "Meeting",
        "start_datetime": start.strftime("%Y-%m-%dT%H:%M:%S"),
        "timezone": data.timezone or "Asia/Kolkata",
        "event_duration_hour": mins // 60,
        "event_duration_minutes": mins % 60,
        "attendees": guests,
        "create_meeting_room": True,
        "send_updates": "all",
    }
    if data.description:
        args["description"] = data.description
    try:
        out = pod.connectors.execute("google_calendar", "GOOGLECALENDAR_CREATE_EVENT", args, **use)
    except Exception as exc:
        res.error = f"Calendar refused the invite: {str(exc)[:200]}"
        return res

    body = out if isinstance(out, dict) else {}
    ev = body.get("data") or body.get("response_data") or body
    if isinstance(ev, dict) and isinstance(ev.get("response_data"), dict):
        ev = ev["response_data"]
    res.sent = True
    res.event_id = str((ev or {}).get("id") or "")
    res.link = str((ev or {}).get("hangoutLink") or (ev or {}).get("htmlLink") or "")
    return res
