#input_type_name: TriageInput
#output_type_name: TriageResult
#function_name: triage

"""Sort new mail into two piles before anything is read carefully: Read, or Noise.

The unit is the conversation, never the single message: a thread is read whole or not at
all, because half a thread has no context.

`mode: "rules"` settles what needs no judgement:
  * the person wrote somewhere in the thread            -> Read
  * it is from someone they have written to, somebody
    already known to them, a colleague of somebody
    known (same company domain), or their own team      -> Read
  * meetings and meeting notes                          -> Read
Everything else is undecided: mail from somebody new that the person has not answered.
That is where cold pitches live, and also where a first message from a real customer
lives, so no rule may decide it. Undecided threads are handed back, with the sender, the
subject and the opening lines, for a model to judge. If there are only a few, they are
simply marked Read: asking a model is slower than reading them.

`mode: "apply"` records the verdicts. Noise is filed with its reason and never deleted,
so "show me my newsletters" stays possible later. A conversation given no verdict is left
alone here and becomes readable when its hold runs out: when in doubt, read.
"""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
    "yahoo.co.in", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
    "gmx.com", "mail.com", "zoho.com", "rediffmail.com", "fastmail.com", "hey.com",
}
SORT_AT_LEAST = 4        # fewer undecided threads than this are quicker read than sorted
MAX_UNDECIDED = 120
SORT_LEASE_MIN = 6


class Verdict(BaseModel):
    thread: str
    noise: bool = False
    reason: str | None = None


class TriageInput(BaseModel):
    mode: str = "rules"                       # rules | list | apply
    verdicts: list[Verdict] = Field(default_factory=list)


class Undecided(BaseModel):
    thread: str
    sender: str = ""
    subject: str = ""
    opening: str = ""
    messages: int = 1


class TriageResult(BaseModel):
    sort: bool = False                        # true: undecided threads are waiting on a model
    read: int = 0                             # threads put in Read
    noise: int = 0                            # threads filed as Noise
    undecided: list[Undecided] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _emails(parts, role: str | None = None) -> list[str]:
    out = []
    for p in (parts if isinstance(parts, list) else []):
        if not isinstance(p, dict):
            continue
        if role and p.get("role") != role:
            continue
        e = (p.get("email") or "").strip().lower()
        if e:
            out.append(e)
    return out


async def triage(ctx: FunctionContext, data: TriageInput) -> TriageResult:
    pod = ctx.pod or Pod.from_env()
    res = TriageResult()

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    def mark(ids: list[str], patch: dict) -> None:
        # one write per row, so side by side: a first run marks a hundred rows or more,
        # and one after another that is a minute before any reader can start
        def one(i: str) -> None:
            try:
                pod.records.update("interactions", i, patch)
            except Exception as exc:
                res.errors.append(f"{str(i)[:8]}: {str(exc)[:80]}")
        if len(ids) < 4:
            for i in ids:
                one(i)
            return
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(one, ids))

    if (data.mode or "rules").lower() == "apply":
        waiting = rows(
            "select id, thread_ref from interactions "
            "where extracted_at is null and triage = 'sorting'")
        by_thread: dict[str, list[str]] = {}
        for r in waiting:
            by_thread.setdefault(r.get("thread_ref") or str(r["id"]), []).append(str(r["id"]))
        said = {v.thread: v for v in data.verdicts}
        now = _now().isoformat()
        for thread, ids in by_thread.items():
            v = said.get(thread)
            if v is None:
                # not one of the conversations this sorter was shown: another sorter running
                # beside it has those, and if nobody ever rules on them they become readable
                # by themselves when their hold runs out
                continue
            if v.noise:
                mark(ids, {"triage": "noise", "extracted_at": now, "extractor_version": "noise",
                           "summary": (v.reason or "Not something that needs you")[:200],
                           "claimed_until": None})
                res.noise += 1
            else:
                mark(ids, {"triage": "read", "claimed_until": None})
                res.read += 1
        return res

    def opening_of(row: dict) -> str:
        if not row.get("body_ref"):
            return ""
        try:
            text = pod.files.download(row["body_ref"]).decode("utf-8", "replace")
            # the stored file starts with a small header; the mail is after the rule
            return re.sub(r"\s+", " ", text.split("\n---\n", 1)[-1]).strip()[:320]
        except Exception:
            return ""

    if (data.mode or "").lower() == "list":
        # what is waiting on a verdict, for whoever is about to give one
        waiting = rows(
            "select id, thread_ref, subject, participants, body_ref, occurred_at from interactions "
            "where extracted_at is null and triage = 'sorting' order by occurred_at desc limit 400")
        by: dict[str, list[dict]] = {}
        for r in waiting:
            by.setdefault(r.get("thread_ref") or str(r["id"]), []).append(r)
        picked = list(by.items())[:MAX_UNDECIDED]
        with ThreadPoolExecutor(max_workers=8) as pool:
            openings = list(pool.map(lambda kv: opening_of(kv[1][0]), picked))
        for (thread, items), opening in zip(picked, openings):
            latest = items[0]
            res.undecided.append(Undecided(
                thread=thread, sender=next(iter(_emails(latest.get("participants"), "from")), ""),
                subject=(latest.get("subject") or "")[:140], opening=opening, messages=len(items)))
        res.sort = bool(res.undecided)
        return res

    # ---------------- rules ----------------
    fresh = rows(
        "select id, kind, source, thread_ref, direction, subject, participants, body_ref, occurred_at "
        "from interactions where extracted_at is null and triage is null "
        "order by occurred_at desc limit 600")
    if not fresh:
        return res

    mine = {(getattr(ctx, "user_email", "") or "").strip().lower()}
    # everybody the person has written to, and every thread they have written in
    known: set[str] = set()
    my_threads: set[str] = set()
    for r in rows("select thread_ref, participants from interactions "
                  "where direction = 'outbound' order by occurred_at desc limit 1500"):
        if r.get("thread_ref"):
            my_threads.add(r["thread_ref"])
        known.update(_emails(r.get("participants"), "to"))
        mine.update(_emails(r.get("participants"), "from"))
    try:
        known.update((r.get("email") or "").lower() for r in rows(
            "select email from people where email is not null"))
    except Exception:
        pass
    mine.discard("")
    team = {m.split("@")[-1] for m in mine if "@" in m} - FREE_MAIL
    # a company the person already deals with: a new name from there is a colleague, not a
    # stranger, and belongs with the rest of that company's mail
    known_domains = {k.split("@")[-1] for k in known if "@" in k} - FREE_MAIL

    threads: dict[str, list[dict]] = {}
    for r in fresh:
        threads.setdefault(r.get("thread_ref") or str(r["id"]), []).append(r)

    read_ids: list[str] = []
    undecided: list[tuple[str, list[dict]]] = []
    for thread, items in threads.items():
        ids = [str(x["id"]) for x in items]
        if any((x.get("kind") or "") != "email" for x in items):
            read_ids += ids
            res.read += 1
            continue
        senders = {e for x in items for e in _emails(x.get("participants"), "from")} - mine
        i_wrote = thread in my_threads or any((x.get("direction") or "") == "outbound" for x in items)
        if (i_wrote or (senders & known)
                or any(s.split("@")[-1] in team or s.split("@")[-1] in known_domains
                       for s in senders)):
            read_ids += ids
            res.read += 1
        else:
            undecided.append((thread, items))

    mark(read_ids, {"triage": "read"})

    if len(undecided) < SORT_AT_LEAST:
        # too few to be worth a model's time: read them
        mark([str(x["id"]) for _, items in undecided for x in items], {"triage": "read"})
        res.read += len(undecided)
        return res

    lease = (_now() + timedelta(minutes=SORT_LEASE_MIN)).isoformat()
    # (the sorter fetches the opening lines itself, with `list`; nothing here needs them)
    mark([str(x["id"]) for _, items in undecided[:MAX_UNDECIDED] for x in items],
         {"triage": "sorting", "claimed_until": lease})
    for thread, items in undecided[:MAX_UNDECIDED]:
        latest = items[0]
        res.undecided.append(Undecided(
            thread=thread,
            sender=next(iter(_emails(latest.get("participants"), "from")), ""),
            subject=(latest.get("subject") or "")[:140],
            messages=len(items),
        ))
    # anything beyond the cap is read rather than left waiting
    extra = [str(x["id"]) for _, items in undecided[MAX_UNDECIDED:] for x in items]
    mark(extra, {"triage": "read"})
    res.read += len(undecided[MAX_UNDECIDED:])
    res.sort = True
    return res
