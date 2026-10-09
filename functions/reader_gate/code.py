#input_type_name: GateInput
#output_type_name: GateResult
#function_name: reader_gate

"""One reader at a time, and only when there is something to read.

Reading used to be fired by a trigger on the ledger: one run for every row written. That
is fine for a single email and ruinous for sixty at once — sixty runs start together,
most time out, and the platform switches the trigger off, after which nothing is read at
all and the desk quietly goes stale.

So nothing is triggered per row any more. Whatever writes to the ledger (a mail or
calendar watcher, the nightly pass, the catch-up) asks this gate once, afterwards, whether
a reading pass should start:

  * nothing unread                     -> no
  * a first-run import is in progress  -> no (the import reads its own rows)
  * a pass was started recently        -> no (it takes batch after batch until none is left)
  * otherwise                          -> yes, and the lease is taken so the next asker waits

`done: true` is the other half: the pass has finished, the lease is released.
The lease lives in the person's own `settings`, so it is theirs alone.
"""

from datetime import datetime, timedelta, timezone

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

LEASE_MIN = 15


class GateInput(BaseModel):
    done: bool = False           # the reading pass has finished: release the lease
    ignore_import: bool = False  # a pass somebody asked for by hand reads during an import too


class GateResult(BaseModel):
    skip: bool = True            # the workflow's rule tests this: true means do not read
    unread: int = 0
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

    def setting(key: str) -> dict | None:
        rows = pod.query(
            f"select id, value from settings where key = '{key}' "
            "order by updated_at desc limit 1").to_dict()["items"]
        return rows[0] if rows else None

    def put(key: str, value: str) -> None:
        row = setting(key)
        if row:
            pod.table("settings").update(row["id"], {"value": value})
        else:
            pod.table("settings").create({"key": key, "value": value})

    try:
        unread = int((pod.query(
            "select count(*) as n from interactions where extracted_at is null"
        ).to_dict()["items"][0] or {}).get("n") or 0)
    except Exception as exc:
        return GateResult(why=f"could not count unread rows: {str(exc)[:120]}")

    if data.done:
        try:
            put("reading_until", datetime.fromtimestamp(0, timezone.utc).isoformat())
        except Exception:
            pass
        return GateResult(unread=unread, why="released")

    if unread == 0:
        return GateResult(why="nothing unread")
    try:
        if not data.ignore_import:
            imp = setting("backfill_until")
            until = _when(imp.get("value")) if imp else None
            if until and until > now:
                return GateResult(unread=unread, why="a first-run import is reading these")
        lease = setting("reading_until")
        held = _when(lease.get("value")) if lease else None
        if held and held > now:
            return GateResult(unread=unread, why="a reading pass is already going")
        put("reading_until", (now + timedelta(minutes=LEASE_MIN)).isoformat())
    except Exception as exc:
        # when in doubt, read: a missed message is worse than a busy minute
        return GateResult(skip=False, unread=unread, why=f"lease unavailable: {str(exc)[:100]}")
    return GateResult(skip=False, unread=unread, why="go")
