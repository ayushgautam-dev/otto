#input_type_name: PendingInput
#output_type_name: PendingResult
#function_name: pending_interactions

# Hands the extractor its work: interactions nobody has read yet, with their body
# text pulled back out of the file store, so the agent gets everything in one call.
#
# This is the whole reason the ledger exists. The extractor no longer knows or cares
# whether something came from Gmail, Granola, Meet or Slack — it reads rows.

from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

MAX_BODY = 12000


class PendingInput(BaseModel):
    limit: int = 10
    body_chars: int = MAX_BODY
    # Set when re-running an improved extractor over history that was already read.
    include_extracted: bool = False


class PendingItem(BaseModel):
    id: str
    kind: str
    source: str
    occurred_at: str | None = None
    subject: str | None = None
    direction: str | None = None
    addressed_to_me: bool = True
    thread_ref: str | None = None
    person_email: str | None = None
    participants: list[dict] = Field(default_factory=list)
    body: str = ""


class Earlier(BaseModel):
    """What came before in a conversation: earlier messages already in the ledger."""
    thread_ref: str
    occurred_at: str | None = None
    direction: str | None = None
    subject: str | None = None
    summary: str | None = None


class ExistingLoop(BaseModel):
    person_email: str
    kind: str
    obligation: str


class PendingResult(BaseModel):
    items: list[PendingItem] = Field(default_factory=list)
    remaining: int = 0
    # Earlier messages of the conversations in `items` that have already been read, oldest
    # first, so a thread is always read whole even when only its newest message is new.
    earlier: list[Earlier] = Field(default_factory=list)
    # Loops already open with the same people. The extractor must read these before
    # writing, so the same obligation phrased differently does not become a second row.
    already_open: list[ExistingLoop] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


def _counterpart(participants: list, direction: str | None, me: str) -> str:
    if not isinstance(participants, list):
        return ""
    def em(p):
        return (p.get("email") or "").strip().lower() if isinstance(p, dict) else ""
    if direction == "outbound":
        for p in participants:
            if isinstance(p, dict) and p.get("role") == "to" and em(p) and em(p) != me:
                return em(p)
    for p in participants:
        if isinstance(p, dict) and p.get("role") == "from" and em(p) and em(p) != me:
            return em(p)
    for p in participants:
        if em(p) and em(p) != me:
            return em(p)
    return ""


CLAIM_MIN = 8
MAX_CLAIM = 14        # small enough that three readers each get a share

# What may be read now: sorted into Read and not taken by another reader. A row the sorter
# never got to (it failed, or the pod predates sorting) becomes readable by itself after a
# while, so nothing can be stranded by a step that did not run.
READABLE = (
    "extracted_at is null and ("
    " (triage = 'read' and (claimed_until is null or claimed_until < now()))"
    " or (triage is null and created_at < now() - interval '8 minutes')"
    " or (triage = 'sorting' and claimed_until < now())"
    ")"
)


async def pending_interactions(ctx: FunctionContext, data: PendingInput) -> PendingResult:
    pod = Pod.from_env()
    res = PendingResult()
    me = (ctx.user_email or "").lower()

    def rows(sql: str) -> list[dict]:
        return pod.query(sql).to_dict()["items"]

    cols = ("id, kind, source, occurred_at, subject, direction, addressed_to_me, "
            "thread_ref, participants, body_ref")
    limit = max(1, min(40, data.limit))

    if data.include_extracted:
        found = rows(f"select {cols} from interactions order by occurred_at desc limit {limit}")
        res.remaining = 0
    else:
        # Mail written straight to the person by somebody first, newest first: the first
        # things found should be the things most likely to need them.
        pool = rows(
            f"select {cols} from interactions where {READABLE} "
            "order by (kind = 'email' and direction = 'inbound' and addressed_to_me) desc, "
            "occurred_at desc limit 400")
        # Take whole people and whole conversations, never part of one: several readers
        # run side by side, and two of them must not be handed the same person's mail.
        def keys(r: dict) -> set[str]:
            k = set()
            who = _counterpart(r.get("participants") or [], r.get("direction"), me)
            if who:
                k.add("p:" + who)
            if r.get("thread_ref"):
                k.add("t:" + r["thread_ref"])
            return k or {"r:" + str(r["id"])}

        taken: set[str] = set()
        found = []
        for r in pool:
            if len(found) >= limit:
                break
            found.append(r)
            taken |= keys(r)
        have = {str(r["id"]) for r in found}
        for r in pool:
            if len(found) >= MAX_CLAIM:
                break
            if str(r["id"]) not in have and keys(r) & taken:
                found.append(r)
                have.add(str(r["id"]))
        res.remaining = max(0, len(pool) - len(found))

        until = (datetime.now(timezone.utc) + timedelta(minutes=CLAIM_MIN)).isoformat()
        for r in found:
            try:
                pod.records.update("interactions", r["id"], {"claimed_until": until, "triage": "read"})
            except Exception as exc:
                res.errors.append(f"could not claim {str(r['id'])[:8]}: {str(exc)[:80]}")
        # a conversation is read in the order it happened
        found.sort(key=lambda r: (r.get("thread_ref") or str(r["id"]), str(r.get("occurred_at") or "")))

    for r in found:
        parts = r.get("participants") or []
        body = ""
        ref = r.get("body_ref")
        if ref:
            try:
                body = pod.files.download(ref).decode("utf-8", "replace")[: data.body_chars]
            except Exception as exc:
                res.errors.append(f"body unreadable for {str(r['id'])[:8]}: {str(exc)[:80]}")
        res.items.append(PendingItem(
            id=str(r["id"]),
            kind=r.get("kind") or "email",
            source=r.get("source") or "gmail",
            occurred_at=str(r.get("occurred_at") or "") or None,
            subject=r.get("subject"),
            direction=r.get("direction"),
            addressed_to_me=bool(r.get("addressed_to_me", True)),
            thread_ref=r.get("thread_ref"),
            person_email=_counterpart(parts, r.get("direction"), me) or None,
            participants=parts if isinstance(parts, list) else [],
            body=body,
        ))

    # The rest of each conversation: what was said before, from rows already read.
    threads = sorted({i.thread_ref for i in res.items if i.thread_ref})
    if threads:
        quoted = ",".join("'" + t.replace("'", "''") + "'" for t in threads[:40])
        try:
            for r in rows(
                "select thread_ref, occurred_at, direction, subject, summary from interactions "
                f"where thread_ref in ({quoted}) and extracted_at is not null "
                "and coalesce(triage, '') <> 'noise' order by occurred_at asc limit 120"
            ):
                res.earlier.append(Earlier(
                    thread_ref=r.get("thread_ref") or "",
                    occurred_at=str(r.get("occurred_at") or "") or None,
                    direction=r.get("direction"), subject=r.get("subject"),
                    summary=r.get("summary"),
                ))
        except Exception as exc:
            res.errors.append(f"could not read earlier messages: {str(exc)[:100]}")

    # What is already outstanding with these same people. Word-overlap matching used to
    # decide this and got it wrong whenever the wording differed — "share the hiring
    # decision" and "decide next steps and let him know" are one obligation, and became
    # two rows. So the judgment moves to the agent, and this is what it judges against.
    emails = sorted({i.person_email for i in res.items if i.person_email})
    if emails:
        quoted = ",".join("'" + e.replace("'", "''") + "'" for e in emails[:60])
        try:
            for r in rows(
                f"select p.email as person_email, l.kind, l.obligation "
                f"from loops l join people p on p.id = l.person_id "
                f"where l.status = 'open' and p.email in ({quoted})"
            ):
                res.already_open.append(ExistingLoop(
                    person_email=r.get("person_email") or "",
                    kind=r.get("kind") or "",
                    obligation=r.get("obligation") or "",
                ))
        except Exception as exc:
            res.errors.append(f"could not read open loops: {str(exc)[:100]}")

    return res
