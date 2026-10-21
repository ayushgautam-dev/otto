#input_type_name: RecordInput
#output_type_name: RecordResult
#function_name: record_interaction

# The ledger writer. Every source — Gmail, Calendar, Meet, Granola, Slack — lands
# here and nowhere else, which is what lets one DATASTORE trigger on `interactions`
# drive the whole understanding layer regardless of where a row came from.
#
# This function forms no opinion about content. It parses, normalises, dedupes and
# writes. Deciding what an interaction *means* is the extractor's job.
#
# Two destinations per interaction:
#   - a row in `interactions` (light: who, when, subject, pointer)
#   - the raw body as a markdown file under /me (searchable: the second brain's corpus)
#
# /me is delegated, so a run started by a user's own row writes into that user's
# private tree. Nothing here crosses between people.

import re
from datetime import datetime, timezone
from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

CORPUS_ROOT = "/me/people"
UNFILED = "/me/interactions"


class InteractionIn(BaseModel):
    kind: str                                  # email | meeting | message
    source: str                                # gmail | calendar | meet | granola | slack | manual
    external_id: str                           # RFC Message-ID, event id, meeting id — the idempotency key
    occurred_at: str
    thread_ref: str | None = None
    account_id: str | None = None              # which connected account it arrived on
    subject: str | None = None
    body: str | None = None                    # raw text; goes to a file, never to a column
    direction: str | None = None               # inbound | outbound | internal
    addressed_to_me: bool = True
    person_email: str | None = None            # the counterparty, if the source knows it
    company_domain: str | None = None
    participants: list[dict] = Field(default_factory=list)


class PruneIn(BaseModel):
    """Upcoming calendar rows that are no longer on the calendar. After a calendar is read
    for a window, any stored future meeting from that calendar which was not in what came
    back has been cancelled or deleted, and must stop showing as "next up"."""
    prefix: str                       # which calendar's ids: "gcal:" or "ocal:"
    start: str                        # the window that was just read, ISO
    end: str
    keep: list[str] = Field(default_factory=list)   # external ids still on the calendar
    account_id: str | None = None


class RecordInput(BaseModel):
    interactions: list[InteractionIn] = Field(default_factory=list)
    prune: PruneIn | None = None


class RecordResult(BaseModel):
    created: int = 0
    linked: int = 0           # meeting notes tied to the calendar meeting they record
    skipped_duplicate: int = 0
    prefiltered: int = 0      # bulk mail filed as read without a reading pass
    updated: int = 0          # meetings that moved or were renamed
    removed: int = 0          # upcoming meetings no longer on the calendar
    files_written: int = 0
    unresolved_people: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


_KIND = {"email", "meeting", "message"}
_SOURCE = {"gmail", "calendar", "meet", "granola", "slack", "manual"}
_DIRECTION = {"inbound", "outbound", "internal"}


def _norm_email(e: str | None) -> str:
    e = (e or "").strip().lower()
    m = re.match(r"^.*?<([^>]+)>$", e)
    return (m.group(1) if m else e).strip()


def _norm_domain(d: str | None) -> str:
    d = (d or "").strip().lower()
    if not d:
        return ""
    d = re.sub(r"^https?://", "", d).split("/")[0]
    return d[4:] if d.startswith("www.") else d


def _norm_kind(k: str | None) -> str:
    k = (k or "").strip().lower()
    if k in _KIND:
        return k
    if k in ("call", "transcript", "note"):
        return "meeting"
    if k in ("slack", "dm", "chat"):
        return "message"
    return "email"


def _norm_source(s: str | None) -> str:
    s = (s or "").strip().lower()
    if s in _SOURCE:
        return s
    if s in ("mail", "email", "google_mail"):
        return "gmail"
    if s in ("google_calendar", "gcal"):
        return "calendar"
    if s in ("fireflies", "transcript"):
        return "meet"
    return "manual"


def _norm_direction(d: str | None) -> str | None:
    d = (d or "").strip().lower()
    if d in _DIRECTION:
        return d
    if d in ("sent", "outgoing", "from_me"):
        return "outbound"
    if d in ("received", "incoming", "to_me"):
        return "inbound"
    return None


def _iso(ts: str | None) -> str:
    raw = (ts or "").strip()
    if not raw:
        return datetime.now(timezone.utc).isoformat()
    # An offset in the source ("…T11:30:00+05:30") is the truth: convert it. Only a
    # timestamp with no offset at all is assumed to be UTC. This used to overwrite the
    # offset with UTC instead of converting, so every calendar event and meeting note
    # landed 5h30m late for an IST calendar ("Daily Catchup at 3:00" for a 9:30 PM call).
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return raw


def _slug(text: str, limit: int = 60) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (s[:limit].rstrip("-")) or "untitled"


def _folder(person_email: str) -> str:
    return f"{CORPUS_ROOT}/{_slug(person_email, 80)}" if person_email else UNFILED


# Bulk mail that needs nobody: sent by a machine AND carrying a mailing-list footer. Both
# must hold. A "no-reply" address alone is not enough (a signature request or an invoice
# comes from one and does need the person), and neither is a footer alone. Rows that pass
# this test are filed as already read, so the slow, careful reading is spent on real mail.
_MACHINE = re.compile(
    r"^(no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|donotreply|notifications?|newsletters?|news|updates?|"
    r"digest|marketing|mailer[-_.]?daemon|bounces?|hello|team|info|community|events?)([+.\-_][^@]*)?@", re.I)
_LIST_FOOTER = re.compile(
    r"unsubscribe|manage (your )?(email )?preferences|email preferences|view (this email )?in (your )?browser|"
    r"you are receiving this (email|message) because|update your preferences|opt[- ]out", re.I)


def _bulk_mail(item: "InteractionIn", email: str) -> bool:
    if (item.kind or "").lower() != "email" or (item.direction or "").lower() != "inbound":
        return False
    return bool(_MACHINE.search(email or "")) and bool(_LIST_FOOTER.search(item.body or ""))


# ---- A note belongs to a meeting. ----
# The calendar knows who was invited; the note knows what was said. A note-taking tool
# usually lists only the person who took the note, so on its own a note cannot say who
# the promise in it was made to. Every note is therefore tied to the calendar meeting it
# records (`interactions.meeting_id`), whichever of the two arrived first, and takes that
# meeting's attendees when it names nobody itself. Everything downstream — the reader,
# a person's history, the brief before the next meeting — reads who it was with from
# that one link.
LINK_WINDOW_MIN = 75      # a note with the meeting's own title, started this close to it
LINK_EXACT_MIN = 15       # a note under another title: only if it began when the meeting did


def _dt(value) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _words(text: str | None) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) > 2}


def _same_meeting(note: dict, note_at: datetime, meeting: dict, meeting_at: datetime) -> bool:
    """Is this note the record of that meeting? Near in time is not enough: an unplanned
    call an hour after the daily stand-up is not the stand-up. Either the note carries the
    meeting's title (the note-taker copies it from the calendar) and began within the
    window, or it began at the meeting's own start."""
    gap = abs((meeting_at - note_at).total_seconds())
    if gap <= LINK_EXACT_MIN * 60:
        return True
    return gap <= LINK_WINDOW_MIN * 60 and bool(_words(note.get("subject")) & _words(meeting.get("subject")))


def _link_notes(pod, rows, res: "RecordResult") -> None:
    try:
        notes = rows(
            "select id, occurred_at, subject, participants, person_id, meeting_id from interactions "
            "where source in ('granola', 'meet') "
            "and occurred_at > now() - interval '45 days' order by occurred_at desc limit 200")
    except Exception:
        return                      # a pod whose ledger has no meeting_id column yet
    if not notes:
        return
    meetings = rows(
        "select id, occurred_at, subject, participants, person_id, company_id from interactions "
        "where source = 'calendar' and occurred_at > now() - interval '46 days' "
        "and occurred_at < now() + interval '1 day' order by occurred_at desc limit 800")
    timed = [(m, _dt(m.get("occurred_at"))) for m in meetings]
    timed = [(m, at) for m, at in timed if at]
    by_id = {str(m["id"]): (m, at) for m, at in timed}
    for n in notes:
        at = _dt(n.get("occurred_at"))
        if not at:
            continue
        if n.get("meeting_id"):
            # Tied already. Keep it, unless the meeting has since moved or been renamed so
            # that it no longer holds; then let it go rather than leave a wrong pairing.
            was = by_id.get(str(n["meeting_id"]))
            if not was or _same_meeting(n, at, was[0], was[1]):
                continue
            try:
                pod.records.update("interactions", n["id"], {"meeting_id": None})
            except Exception:
                continue
            # ...and look again below: the right meeting may have been recorded since
        near = [(m, abs((mat - at).total_seconds())) for m, mat in timed if _same_meeting(n, at, m, mat)]
        if not near:
            continue
        # two meetings back to back: the one whose title the note shares, then the nearer
        title = _words(n.get("subject"))
        best = max(near, key=lambda mg: (len(title & _words(mg[0].get("subject"))), -mg[1]))[0]
        patch: dict = {"meeting_id": best["id"]}
        named = [p for p in (n.get("participants") or []) if isinstance(p, dict) and p.get("email")]
        invited = [p for p in (best.get("participants") or []) if isinstance(p, dict) and p.get("email")]
        if not named and invited:
            patch["participants"] = [dict(p, via="calendar") for p in invited]
            if not n.get("person_id") and len(invited) == 1 and best.get("person_id"):
                patch["person_id"] = best["person_id"]
                if best.get("company_id"):
                    patch["company_id"] = best["company_id"]
        try:
            pod.records.update("interactions", n["id"], patch)
            res.linked += 1
        except Exception as exc:
            res.errors.append(f"could not tie a note to its meeting: {str(exc)[:120]}")
            return                  # most likely the column is missing: do not retry per row


async def record_interaction(ctx: FunctionContext, data: RecordInput) -> RecordResult:
    pod = Pod.from_env()
    res = RecordResult()

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    seen = {r["external_id"] for r in rows(
        "select external_id from interactions where external_id is not null")}
    # Meetings are the one kind of row that changes after it is written: they get moved
    # and renamed. Keep what is stored for each so a change can be carried over.
    meetings = {r["external_id"]: r for r in rows(
        "select id, external_id, occurred_at, subject, account_id, thread_ref, triage from interactions "
        "where source = 'calendar' and external_id is not null")}
    # A series the person took off their desk stays off it: its later occurrences arrive
    # marked as noise too, so nothing reads, briefs or shows them.
    muted_series = {r["thread_ref"] for r in meetings.values()
                    if r.get("triage") == "noise" and r.get("thread_ref")
                    and r["thread_ref"] != r["external_id"]}
    person_by_email = {r["email"]: r["id"] for r in rows(
        "select id, email from people where email is not null")}
    company_by_domain = {r["domain"]: r["id"] for r in rows(
        "select id, domain from companies where domain is not null")}

    batch: list[dict] = []
    for item in data.interactions:
        ext = (item.external_id or "").strip()
        if not ext:
            res.errors.append("interaction without external_id skipped")
            continue
        if ext in seen:
            was = meetings.get(ext)
            if was:
                # the same meeting, at a new time or under a new name: follow it
                patch = {}
                now_at = _iso(item.occurred_at)
                if now_at and _iso(str(was.get("occurred_at") or "")) != now_at:
                    patch["occurred_at"] = now_at
                if item.subject and (was.get("subject") or "") != item.subject:
                    patch["subject"] = item.subject
                if patch:
                    try:
                        pod.records.update("interactions", was["id"], patch)
                        res.updated += 1
                    except Exception as exc:
                        res.errors.append(f"could not update a moved meeting: {str(exc)[:120]}")
            res.skipped_duplicate += 1
            continue
        seen.add(ext)

        occurred = _iso(item.occurred_at)
        email = _norm_email(item.person_email)
        domain = _norm_domain(item.company_domain)

        row: dict = {
            "kind": _norm_kind(item.kind),
            "source": _norm_source(item.source),
            "external_id": ext[:300],
            "occurred_at": occurred,
            "addressed_to_me": bool(item.addressed_to_me),
        }
        if item.thread_ref:
            row["thread_ref"] = item.thread_ref[:300]
            if row["source"] == "calendar" and row["thread_ref"] in muted_series:
                row["triage"] = "noise"
        if item.account_id:
            row["account_id"] = item.account_id[:80]
        if item.subject:
            row["subject"] = item.subject
        direction = _norm_direction(item.direction)
        if direction:
            row["direction"] = direction
        if item.participants:
            row["participants"] = item.participants
        if email and email in person_by_email:
            row["person_id"] = person_by_email[email]
        elif email:
            res.unresolved_people.append(email)
        if domain and domain in company_by_domain:
            row["company_id"] = company_by_domain[domain]

        # The body is the corpus. Markdown so the pod indexes it; a front-matter
        # header so a retrieved chunk still says who and when on its own.
        if item.body and item.body.strip():
            path = f"{_folder(email)}/{occurred[:10]}-{_slug(item.subject or row['kind'])}-{_slug(ext, 24)}.md"
            header = (
                f"# {item.subject or row['kind'].title()}\n\n"
                f"- when: {occurred}\n"
                f"- source: {row['source']}\n"
                f"- with: {email or 'unknown'}\n"
                f"- direction: {direction or 'unknown'}\n\n---\n\n"
            )
            try:
                pod.files.write_text(path, header + item.body.strip())
                row["body_ref"] = path
                res.files_written += 1
            except Exception as exc:                      # a lost body must not lose the row
                res.errors.append(f"file write failed for {ext[:40]}: {exc}")

        if _bulk_mail(item, email):
            row["extracted_at"] = datetime.now(timezone.utc).isoformat()
            row["extractor_version"] = "prefilter"
            row["summary"] = "Automated bulk mail, filed without reading"
            res.prefiltered += 1

        batch.append(row)

    if batch:
        pod.records.bulk_create("interactions", batch)
        res.created = len(batch)

    # A meeting or a note has come through (new, or seen again): tie notes to their
    # meetings. Seen-again counts, so notes recorded before this link existed are tied
    # the next time the calendar is read. With nothing left to tie it is one small query.
    if any(_norm_kind(i.kind) == "meeting" for i in data.interactions):
        _link_notes(pod, rows, res)

    if data.prune and data.prune.keep:
        pr = data.prune
        keep = set(pr.keep)
        now = datetime.now(timezone.utc)
        try:
            lo = max(now, datetime.fromisoformat(_iso(pr.start)))
            hi = datetime.fromisoformat(_iso(pr.end))
        except Exception:
            lo = hi = now
        for ext, was in meetings.items():
            if not ext.startswith(pr.prefix) or ext in keep:
                continue
            # only this calendar's own rows (or rows from before accounts were recorded)
            if pr.account_id and was.get("account_id") and was.get("account_id") != pr.account_id:
                continue
            try:
                at = datetime.fromisoformat(_iso(str(was.get("occurred_at") or "")))
            except Exception:
                continue
            # the past is history and stays; only what was still to come can be cancelled
            if lo < at < hi:
                try:
                    pod.records.delete("interactions", was["id"])
                    res.removed += 1
                except Exception as exc:
                    res.errors.append(f"could not remove a cancelled meeting: {str(exc)[:120]}")

    return res
