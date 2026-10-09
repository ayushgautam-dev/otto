#input_type_name: GateInput
#output_type_name: GateResult
#function_name: reader_gate

"""A few readers at a time, and only when there is something to read.

Reading used to be fired by a trigger on the ledger: one run for every row written. That
is fine for a single email and ruinous for sixty at once — sixty runs start together,
most time out, and the platform switches the trigger off, after which nothing is read at
all and the desk quietly goes stale.

So nothing is triggered per row. Whatever writes to the ledger (a mail or calendar
watcher, the nightly pass, the catch-up, the app during first run) asks this gate whether
a reading pass should start:

  * nothing waiting that a reader could take   -> no
  * a first-run import is in progress           -> no, unless asked for by hand
  * all reading slots are taken                 -> no (those readers take batch after batch)
  * otherwise                                   -> yes, and a slot is taken

Up to MAX_READERS run side by side. That is safe because a reader is only ever handed
whole people and whole conversations (see pending_interactions), so two of them never
work on the same person's mail.

`done: true` hands the slot back, and says whether anything new is now owed by the person
with no draft written for it, so the workflow can write those drafts straight away.
The slots live in the person's own `settings`, so they are theirs alone.
"""

import json
import uuid
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

MAX_READERS = 3
SLOT_MIN = 15


class GateInput(BaseModel):
    done: bool = False           # the reading pass has finished: hand the slot back
    slot: str | None = None      # which slot, as given out when the pass started
    ignore_import: bool = False  # a pass somebody asked for by hand reads during an import too


class GateResult(BaseModel):
    skip: bool = True            # the workflow's rule tests this: true means do not read
    slot: str = ""
    unread: int = 0
    draft: bool = False          # on `done`: something is newly owed and has no draft yet
    why: str = ""


def _when(value) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


async def reader_gate(ctx: FunctionContext, data: GateInput) -> GateResult:
    pod = ctx.pod or Pod.from_env()
    now = datetime.now(timezone.utc)

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    def setting(key: str) -> dict | None:
        found = rows(f"select id, value from settings where key = '{key}' "
                     "order by updated_at desc limit 1")
        return found[0] if found else None

    def put(key: str, value: str) -> None:
        row = setting(key)
        if row:
            pod.table("settings").update(row["id"], {"value": value})
        else:
            pod.table("settings").create({"key": key, "value": value})

    def slots() -> list[dict]:
        try:
            raw = json.loads((setting("reading_slots") or {}).get("value") or "[]")
        except Exception:
            raw = []
        return [s for s in raw if isinstance(s, dict) and (_when(s.get("until")) or now) > now]

    if data.done:
        res = GateResult(why="released")
        left = [s for s in slots() if s.get("id") != data.slot]
        try:
            put("reading_slots", json.dumps(left))
        except Exception:
            pass
        if not left:
            # The last reader has gone. Anything it took and did not finish (a reader can
            # be handed more than it gets through) is let go at once, so the next reader
            # can have it now and not when the hold happens to run out.
            try:
                for r in rows("select id from interactions where extracted_at is null "
                              "and triage = 'read' and claimed_until > now() limit 200"):
                    pod.records.update("interactions", r["id"], {"claimed_until": None})
            except Exception:
                pass
        try:
            owed = rows(
                "select count(*) as n from loops l where l.status = 'open' and l.side = 'you' "
                "and l.created_at > now() - interval '45 minutes' "
                "and not exists (select 1 from drafts d where d.loop_id = l.id)")
            res.draft = int((owed[0] or {}).get("n") or 0) > 0
            # one writer at a time: readers finishing together must not each draft the
            # same replies
            if res.draft:
                busy = _when((setting("drafting_until") or {}).get("value"))
                if busy and busy > now:
                    res.draft = False
                else:
                    put("drafting_until", (now + timedelta(minutes=8)).isoformat())
        except Exception:
            res.draft = False
        return res

    # what a reader starting now could actually take: unread, not filed as noise, and not
    # already in another reader's hands
    try:
        unread = int((rows(
            "select count(*) as n from interactions where extracted_at is null "
            "and coalesce(triage, '') <> 'noise' "
            "and (claimed_until is null or claimed_until < now() or coalesce(triage, '') = 'sorting')"
        )[0] or {}).get("n") or 0)
    except Exception as exc:
        return GateResult(why=f"could not count unread rows: {str(exc)[:120]}")
    if unread == 0:
        return GateResult(why="nothing waiting")

    try:
        if not data.ignore_import:
            imp = setting("backfill_until")
            until = _when(imp.get("value")) if imp else None
            if until and until > now:
                return GateResult(unread=unread, why="a first-run import is reading these")
        live = slots()
        if len(live) >= MAX_READERS:
            return GateResult(unread=unread, why="every reading slot is taken")
        mine = uuid.uuid4().hex[:10]
        live.append({"id": mine, "until": (now + timedelta(minutes=SLOT_MIN)).isoformat()})
        put("reading_slots", json.dumps(live))
    except Exception as exc:
        # when in doubt, read: a missed message is worse than a busy minute
        return GateResult(skip=False, unread=unread, why=f"slots unavailable: {str(exc)[:100]}")
    return GateResult(skip=False, slot=mine, unread=unread, why="go")
