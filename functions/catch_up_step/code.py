#input_type_name: StepInput
#output_type_name: StepResult
#function_name: catch_up_step

"""One step of somebody's first-run history, run as that person.

First run collects the last week in the app so the desk can open, then hands over to the
`catch_up` workflow, whose first node is this function. It keeps its place in that
person's `settings.catchup` row:

    {"covered": 7, "target": 21, "sources": ["gmail", ...], "extras": false,
     "loaded": false, "done": false, "unread": 12}

Each call does at most one thing, in this order:
  * older history not collected yet -> collect ALL of it now, side by side (the two older
    weeks of mail, the calendar, meeting notes). Nothing is read until this is done:
    reading hands one reader a whole company, and a company's story is only whole once
    every week is in.
  * unread rows are waiting -> ask for a reading pass (`read: true`);
  * everything read -> mark done, let watchers resume, and ask for the closing check
    (`reconcile: true`), which runs after the person has been told it is finished.

Mail is collected a week at a time: one call that fetches a whole inbox outlives the
request limit. Duplicates are skipped by the ledger, so an overlap costs nothing.
"""

import json
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel
from lemma_sdk import FunctionContext, Pod

# A timer may tick at most every 15 minutes, so each tick takes a week of mail.
SLICE_DAYS = 7
SLICE_MAX = 80
STALL_MIN = 30
MAIL_FILTER = "-in:spam -in:trash -category:promotions -category:social -category:forums"


class StepInput(BaseModel):
    reconciled: bool = False     # the closing check has just finished


class StepResult(BaseModel):
    read: bool = False
    # the workflow's rule tests this one: a rule matches on a true value, and "not read"
    # written as a negation in the rule never matched
    skip: bool = True
    did: str = ""
    covered: int = 0
    unread: int = 0
    done: bool = False
    # everything is read: check what was found against the whole history, once
    reconcile: bool = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _when(value) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _setting(pod: Pod, key: str) -> dict | None:
    rows = pod.query(
        f"select id, value from settings where key = '{key}' "
        "order by updated_at desc limit 1").to_dict()["items"]
    return rows[0] if rows else None


def _put(pod: Pod, key: str, value: str) -> None:
    row = _setting(pod, key)
    if row:
        pod.table("settings").update(row["id"], {"value": value})
    else:
        pod.table("settings").create({"key": key, "value": value})


def _unread(pod: Pod) -> int:
    rows = pod.query(
        "select count(*) as n from interactions where extracted_at is null").to_dict()["items"]
    return int((rows[0] or {}).get("n") or 0) if rows else 0


def _total(pod: Pod) -> int:
    rows = pod.query("select count(*) as n from interactions").to_dict()["items"]
    return int((rows[0] or {}).get("n") or 0) if rows else 0


def _day(days_ago: int) -> str:
    d = _now() - timedelta(days=days_ago)
    return f"{d.year}/{d.month}/{d.day}"


async def catch_up_step(ctx: FunctionContext, data: StepInput) -> StepResult:
    pod = ctx.pod or Pod.from_env()
    try:
        row = _setting(pod, "catchup")
        state = json.loads(row["value"]) if row else None
    except Exception:
        state = None
    if state and data.reconciled:
        state["reconciled"] = True
        state.pop("reconciling_until", None)
        _put(pod, "catchup", json.dumps(state))
        return StepResult(did="closing check recorded", done=bool(state.get("done")))
    if not state or state.get("done"):
        return StepResult(did="nothing to do", done=True)

    sources = state.get("sources") or []
    target = int(state.get("target") or 21)
    covered = int(state.get("covered") or 0)
    res = StepResult(covered=covered)

    def save() -> None:
        state["unread"] = res.unread
        _put(pod, "catchup", json.dumps(state))

    def hold(minutes: int) -> None:
        # stand the per-mail trigger down for this person while rows land in bulk
        until = _now() + timedelta(minutes=minutes) if minutes else datetime.fromtimestamp(0, timezone.utc)
        _put(pod, "backfill_until", until.isoformat())

    landed = 0

    def load(name: str, payload: dict) -> None:
        # what a sync says it recorded is trusted over a count taken straight after it:
        # the rows are not always visible to a query in the same breath
        nonlocal landed
        try:
            out = pod.functions.run(name, payload).to_dict()
            landed += int((out.get("output_data") or {}).get("recorded") or 0)
        except Exception:
            pass

    # ---- 1. collect whatever is not in yet, all of it, before anything is read ----
    if not state.get("loaded"):
        hold(40)
        jobs: list[tuple[str, dict]] = []
        at = covered
        while at < target:
            to = min(target, at + SLICE_DAYS)
            if "gmail" in sources:
                jobs.append(("sync_gmail", {
                    "query": f"after:{_day(to + 1)} before:{_day(max(at - 1, 0))} {MAIL_FILTER}",
                    "max_messages": SLICE_MAX, "batch_size": 10}))
            if "outlook" in sources:
                jobs.append(("sync_outlook", {
                    "what": "mail", "max_messages": SLICE_MAX, "batch_size": 10,
                    "since": (_now() - timedelta(days=to + 1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "until": (_now() - timedelta(days=max(at - 1, 0))).strftime("%Y-%m-%dT%H:%M:%SZ")}))
            at = to
        if not state.get("extras"):
            if "google_calendar" in sources:
                jobs.append(("sync_calendar", {
                    "past_days": target, "future_days": 14, "max_events": 150, "batch_size": 10}))
            if "outlook" in sources:
                jobs.append(("sync_outlook", {
                    "what": "calendar", "past_days": target, "future_days": 14, "max_events": 150, "batch_size": 10}))
            if "granola" in sources:
                jobs.append(("sync_granola", {"time_range": "last_30_days", "batch_size": 10}))
        # side by side: each is a separate call to a separate source, and waiting for them
        # one after another is most of what the person waits for before anything is read
        from concurrent.futures import ThreadPoolExecutor
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda j: load(*j), jobs))
        except Exception:
            for j in jobs:
                load(*j)
        covered = state["covered"] = res.covered = target
        state["extras"] = True
        # A collecting call can hand back before its last rows are written. Reading must
        # not start on half a week, so wait until the ledger has stopped growing.
        import time
        seen, still = -1, 0
        for _ in range(15):     # a collecting call that timed out here is still writing; a function gets two minutes in all
            n = _total(pod)
            still = still + 1 if n == seen else 0
            if still >= 2:
                break
            seen = n
            time.sleep(5)
        state["loaded"] = True
        state["loaded_at"] = _now().isoformat()
        res.unread = max(_unread(pod), landed)
        res.did = f"collected everything back to {target} days"
        # more readers for what has just arrived, started here so that reading does not
        # depend on the app being open (the gate turns away any beyond its limit)
        if res.unread > 0:
            for _ in range(2):
                try:
                    pod.workflows.create_run("autopilot_loose_ends")
                except Exception:
                    break
        res.read, res.skip = res.unread > 0, not res.unread > 0
        save()
        return res

    # ---- 2. read ----
    unread = _unread(pod)
    res.unread = unread
    if unread > 0:
        # rows that never get read (a reader that keeps failing on them) must not hold
        # the finish hostage for ever: after a long stall, carry on without them
        if unread == state.get("unread_seen"):
            since = _when(state.get("unread_since")) or _now()
            if _now() - since > timedelta(minutes=STALL_MIN):
                unread = 0
        else:
            state["unread_seen"] = unread
            state["unread_since"] = _now().isoformat()
    if unread > 0:
        hold(40)
        res.read, res.skip, res.did = True, False, "asked for a reading pass"
        save()
        return res

    # ---- 3. finished ----
    # Everything is read, so the person is told so now. The closing check (what was found,
    # against the whole history) and the full grouping into topics follow in this same
    # run, behind the scenes: they take many minutes and nobody should wait on them.
    state["done"] = res.done = True
    hold(0)
    res.reconcile = not state.get("reconciled")
    res.did = "finished reading; closing check follows"
    save()
    return res
