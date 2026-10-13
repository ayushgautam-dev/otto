#input_type_name: SyncCalendarInput
#output_type_name: SyncCalendarResult
#function_name: sync_calendar

# Google Calendar -> the interaction ledger. A meeting becomes an interaction like
# anything else, so the extractor treats a call and an email the same way.
#
# The body is what we know about the meeting from the calendar alone: title, when,
# who came, the agenda if there is one. The actual notes arrive separately, from
# Granola or Meet, once the call has happened.
#
# No judgment here. Whether a meeting mattered, whether a standing series is a real
# project, whether anything was promised — all of that is read later, from the row.
#
# Three things this must get right, each of which used to drop real meetings:
#   * every calendar the person keeps switched on, not only the main one. A work
#     calendar shared into a personal account, a team calendar: those are where the
#     meetings set up by other people's tools (Teams, Zoom) tend to sit.
#   * what is still to come is read FIRST and never crowded out. One read ordered from
#     the oldest day spent the whole allowance on last week's meetings on a busy
#     calendar and never reached tomorrow.
#   * the call link, whoever hosts it. Only Google Meet used to be recognised.

import re
from datetime import datetime, timedelta, timezone
from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod


class SyncCalendarInput(BaseModel):
    past_days: int = 30
    future_days: int = 7
    max_events: int = 120          # per calendar, for the past; what is to come is read in full
    batch_size: int = 15


class SyncCalendarResult(BaseModel):
    calendars: int = 0
    fetched: int = 0
    shaped: int = 0
    recorded: int = 0
    skipped_duplicate: int = 0
    files_written: int = 0
    errors: list[str] = []


def _name_from(email: str) -> str:
    local = (email or "").split("@")[0]
    return local.replace(".", " ").replace("_", " ").title()


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


def _events(pod, use: dict, calendar_id: str, tmin: str, tmax: str, cap: int) -> tuple[list[dict], bool]:
    """Events of one calendar in a window, in order, page by page. Second value: whether
    the window was read to its end (so that what is missing from it has truly gone)."""
    got: list[dict] = []
    token = None
    for _ in range(6):
        payload = {"calendarId": calendar_id, "timeMin": tmin, "timeMax": tmax,
                   "maxResults": min(250, max(1, cap - len(got))), "singleEvents": True, "orderBy": "startTime"}
        if token:
            payload["pageToken"] = token
        body = _unwrap(pod.connectors.execute("google_calendar", "GOOGLECALENDAR_EVENTS_LIST", payload, **use))
        got += body.get("items") or []
        token = body.get("nextPageToken") or body.get("next_page_token")
        if not token:
            return got, True
        if len(got) >= cap:
            return got, False
    return got, False



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


async def sync_calendar(ctx: FunctionContext, data: SyncCalendarInput) -> SyncCalendarResult:
    pod = Pod.from_env()
    res = SyncCalendarResult()
    me = (ctx.user_email or "").lower()
    now = datetime.now(timezone.utc)

    fmt = "%Y-%m-%dT%H:%M:%SZ"
    tmin = (now - timedelta(days=data.past_days)).strftime(fmt)
    tnow = now.strftime(fmt)
    tmax = (now + timedelta(days=data.future_days)).strftime(fmt)

    # every Google calendar of mine; with none listed, the workspace default as before
    mine = _my_addresses(pod, ctx)
    accounts = _my_accounts(pod, ctx, "google_calendar") or [{"id": "", "email": ""}]
    items: list[dict] = []
    windows: list[dict] = []
    seen_ids: set[str] = set()
    for acct in accounts:
        use = {"account_id": acct["id"]} if acct["id"] else {}
        calendars = _my_calendars(pod, use)
        res.calendars += len(calendars)
        upcoming_whole = True
        still_there: list[str] = []
        for cal in calendars:
            # what is to come first, and all of it; then the past, newest kept if it is cut
            try:
                ahead, whole = _events(pod, use, cal["id"], tnow, tmax, 500)
            except Exception as exc:
                res.errors.append(f"{cal['name'] or 'calendar'}: {str(exc)[:160]}")
                upcoming_whole = False
                continue
            upcoming_whole = upcoming_whole and whole
            try:
                behind, _ = _events(pod, use, cal["id"], tmin, tnow, max(data.max_events, 60) * 3)
            except Exception as exc:
                res.errors.append(f"{cal['name'] or 'calendar'} (past): {str(exc)[:160]}")
                behind = []
            behind = behind[-max(data.max_events, 60):]
            for ev in behind + ahead:
                eid = ev.get("id")
                if not eid or eid in seen_ids:
                    continue          # the same meeting, seen through a second calendar
                seen_ids.add(eid)
                ev["_account"] = acct["id"]
                ev["_calendar"] = "" if cal["primary"] else cal["name"]
                items.append(ev)
            still_there += [f"gcal:{ev['id']}" for ev in ahead if ev.get("id") and ev.get("status") != "cancelled"]
        # every calendar's coming days were read to the end: what is no longer among
        # them has been cancelled or deleted
        if upcoming_whole and still_there:
            windows.append({"prefix": "gcal:", "start": tnow, "end": tmax,
                            "account_id": acct["id"] or None, "keep": still_there})
    res.fetched = len(items)

    interactions: list[dict] = []
    for ev in items:
        if ev.get("status") == "cancelled" or not ev.get("id"):
            continue
        start = (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date") or ""
        if not start:
            continue

        attendees = []
        for a in (ev.get("attendees") or []):
            em = (a.get("email") or "").strip().lower()
            if not em or em == me or em in mine or a.get("resource"):
                continue
            attendees.append({"email": em, "name": a.get("displayName") or _name_from(em),
                              "role": "attendee"})

        title = (ev.get("summary") or "(untitled)").strip()
        # A one-to-one is with that person. A group meeting has no single counterparty,
        # so leave it unattached rather than guessing.
        counterpart = attendees[0]["email"] if len(attendees) == 1 else ""

        lines = [f"Meeting: {title}", f"When: {start}"]
        if ev.get("_calendar"):
            lines.append(f"Calendar: {ev['_calendar']}")
        if ev.get("location"):
            lines.append(f"Where: {ev['location']}")
        link = _call_link(ev)
        if link:
            lines.append(f"Meeting link: {link}")
        if ev.get("recurringEventId"):
            lines.append("This is one occurrence of a recurring series.")
        if attendees:
            lines.append("Attendees: " + ", ".join(
                f"{a['name']} <{a['email']}>" for a in attendees[:20]))
        if (ev.get("description") or "").strip():
            lines.append("\nAgenda / description:\n" + ev["description"].strip()[:4000])

        interactions.append({
            "kind": "meeting",
            "source": "calendar",
            "external_id": f"gcal:{ev['id']}",
            "thread_ref": ev.get("recurringEventId") or f"gcal:{ev['id']}",
            "account_id": ev.get("_account") or None,
            "occurred_at": start,
            "subject": title,
            "body": "\n".join(lines),
            "direction": "internal",
            "addressed_to_me": True,
            "person_email": counterpart,
            "company_domain": counterpart.split("@")[-1] if "@" in counterpart else None,
            "participants": attendees,
        })

    res.shaped = len(interactions)
    for i in range(0, len(interactions), data.batch_size):
        chunk = interactions[i:i + data.batch_size]
        try:
            out = pod.functions.run("record_interaction", {"interactions": chunk}).to_dict()
        except Exception as exc:
            res.errors.append(f"batch at {i}: {str(exc)[:150]}")
            continue
        d = out.get("output_data") or {}
        res.recorded += d.get("created", 0)
        res.skipped_duplicate += d.get("skipped_duplicate", 0)
        res.files_written += d.get("files_written", 0)

    # meetings that were on a calendar and are gone from it stop showing as upcoming
    for w in windows:
        try:
            pod.functions.run("record_interaction", {"interactions": [], "prune": w})
        except Exception as exc:
            res.errors.append(f"prune: {str(exc)[:120]}")

    # A meeting that has just appeared may be a first meeting with somebody new, and
    # the short brief on them should be ready well before it, not at tomorrow's pass.
    if res.recorded:
        try:
            pod.workflows.create_run("autopilot_meeting_briefs")
        except Exception:
            pass          # the twice-daily run prepares it instead

    return res
