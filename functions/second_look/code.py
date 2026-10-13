#input_type_name: LookInput
#output_type_name: LookResult
#function_name: second_look

"""Open commitments that something has happened to since, somewhere other than the
conversation they are tied to.

A commitment is first seen in one conversation, and the inbox check only ever looks
inside that one. But the matter moves on wherever people happen to write next: the person
sends a NEW email that does what a prepared reply was going to do; the other side answers
in a different thread; it is settled on a call. The reader catches this as each message
arrives (it is shown what is open with everybody on the message, and says what the
message did to it). This is the net under that: it lists the commitments worth a second
look, with what has happened since, so that one agent step can judge just those.

Nothing is decided here. It only finds candidates, cheaply:
  * the commitment is open and belongs to a person with an address;
  * something involving that person was read AFTER the commitment opened (and after the
    last second look), in a different conversation.

`mark: true` records that the look was taken, so the same activity is not raised twice.
"""

from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

MAX_ITEMS = 25
MAX_LATER = 6
BACK_DAYS = 30


class LookInput(BaseModel):
    mark: bool = False          # the look has been taken: remember when
    # look again at everything since each commitment opened, ignoring the last look
    everything: bool = False


class Later(BaseModel):
    occurred_at: str | None = None
    kind: str = ""
    direction: str | None = None
    subject: str | None = None
    summary: str | None = None
    thread_ref: str | None = None
    body_ref: str | None = None


class Item(BaseModel):
    id: str
    side: str = ""
    kind: str = ""
    obligation: str = ""
    person: str = ""
    person_email: str = ""
    opened_at: str | None = None
    thread_ref: str | None = None
    prepared: bool = False      # a reply or nudge is written and waiting for Send
    later: list[Later] = Field(default_factory=list)


class LookResult(BaseModel):
    any: bool = False
    items: list[Item] = Field(default_factory=list)
    marked: bool = False


def _when(value) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


async def second_look(ctx: FunctionContext, data: LookInput) -> LookResult:
    pod = ctx.pod or Pod.from_env()
    res = LookResult()
    now = datetime.now(timezone.utc)

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    def setting(key: str) -> dict | None:
        found = rows(f"select id, value from settings where key = '{key}' order by updated_at desc limit 1")
        return found[0] if found else None

    if data.mark:
        row = setting("second_look_at")
        if row:
            pod.table("settings").update(row["id"], {"value": now.isoformat()})
        else:
            pod.table("settings").create({"key": "second_look_at", "value": now.isoformat()})
        res.marked = True
        return res

    last = None if data.everything else _when((setting("second_look_at") or {}).get("value"))
    floor = now - timedelta(days=BACK_DAYS)

    loops = rows(
        "select l.id, l.side, l.kind, l.obligation, l.opened_at, l.thread_ref, l.person_id, "
        "coalesce(p.name, '') as person, coalesce(p.email, '') as person_email, "
        "(select count(*) from drafts d where d.loop_id = l.id and d.status = 'pending') as prepared "
        "from loops l join people p on p.id = l.person_id "
        "where l.status = 'open' order by l.opened_at desc limit 200")
    if not loops:
        return res

    recent = rows(
        "select id, occurred_at, kind, source, direction, subject, summary, thread_ref, body_ref, "
        "person_id, participants from interactions "
        f"where occurred_at > '{floor.isoformat()}' and extracted_at is not null "
        "and coalesce(triage, '') <> 'noise' and coalesce(extractor_version, '') not in ('noise', 'prefilter') "
        "order by occurred_at desc limit 900")

    def involves(row: dict, loop: dict) -> bool:
        if loop.get("person_id") and str(row.get("person_id") or "") == str(loop["person_id"]):
            return True
        email = (loop.get("person_email") or "").lower()
        if not email:
            return False
        for p in (row.get("participants") or []):
            if isinstance(p, dict) and (p.get("email") or "").strip().lower() == email:
                return True
        return False

    for loop in loops:
        opened = _when(loop.get("opened_at")) or floor
        since = max(opened, last) if last else opened
        later = []
        for r in recent:
            at = _when(r.get("occurred_at"))
            if not at or at <= since:
                continue
            if (r.get("thread_ref") or "") == (loop.get("thread_ref") or "") and r.get("thread_ref"):
                continue        # its own conversation is the inbox check's job
            if involves(r, loop):
                later.append(r)
        if not later:
            continue
        later.sort(key=lambda r: str(r.get("occurred_at") or ""))
        res.items.append(Item(
            id=str(loop["id"]), side=loop.get("side") or "", kind=loop.get("kind") or "",
            obligation=loop.get("obligation") or "", person=loop.get("person") or "",
            person_email=loop.get("person_email") or "",
            opened_at=str(loop.get("opened_at") or "") or None, thread_ref=loop.get("thread_ref"),
            prepared=int(loop.get("prepared") or 0) > 0,
            later=[Later(
                occurred_at=str(r.get("occurred_at") or "") or None, kind=r.get("kind") or "",
                direction=r.get("direction"), subject=r.get("subject"), summary=r.get("summary"),
                thread_ref=r.get("thread_ref"), body_ref=r.get("body_ref"),
            ) for r in later[-MAX_LATER:]],
        ))
        if len(res.items) >= MAX_ITEMS:
            break
    res.any = bool(res.items)
    return res
