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


FREE_MAIL = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
    "yahoo.co.in", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
    "gmx.com", "mail.com", "zoho.com", "rediffmail.com", "fastmail.com", "hey.com",
}


class PendingInput(BaseModel):
    limit: int = 10
    body_chars: int = MAX_BODY
    # The name of the reader asking. A reader that asks again before finishing what it
    # was given gets the SAME rows back, not new ones, so nothing is left held and unread.
    reader: str | None = None
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


def _when(value) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


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


CLAIM_MIN = 5
CLAIM_SEC_PER_ROW = 20
# One reader is handed everything waiting for a company, so that it reads that company's
# whole story. Batches are kept small on purpose: given thirty messages at once a reader
# records the headlines and lets the rest go, and the timeline is the first thing to
# thin out. A company larger than MAX_CLAIM is read in consecutive batches by the SAME
# reader (its next call is given that company first), with what it has already read
# listed in `earlier`.
BATCH_ROWS = 10
MAX_CLAIM = 16
TOTAL_BODY = 260000   # characters of mail in one batch, shared between its rows
EARLY_UNTIL = 24      # rows read so far below which the desk counts as still empty
EARLY_GROUP = 5       # a company this small is whole in one short batch
EARLY_ROWS = 8

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
    found: list[dict] = []

    if data.include_extracted:
        found = rows(f"select {cols} from interactions order by occurred_at desc limit {limit}")
        res.remaining = 0
    else:
        # Mail written straight to the person by somebody first, newest first: the first
        # things found should be the things most likely to need them.
        reader = "".join(ch for ch in (data.reader or "") if ch.isalnum() or ch in "-_")[:40]
        again = []
        if reader:
            try:
                again = rows(
                    f"select {cols} from interactions where extracted_at is null "
                    f"and claimed_by = '{reader}' and claimed_until > now() limit {MAX_CLAIM + 10}")
            except Exception:
                again = []      # a pod from before readers had names
        pool = [] if again else rows(
            f"select {cols} from interactions where {READABLE} "
            "order by (kind = 'email' and direction = 'inbound' and addressed_to_me) desc, "
            "occurred_at desc limit 800")
        # Work is handed out by company: everybody at one company domain goes to the same
        # reader, together. The person's own team, and people on personal addresses, are
        # each their own group, since a shared domain says nothing about them. Several
        # readers run side by side and no two are ever given the same group.
        team = {me.split("@")[-1]} - FREE_MAIL - {""}

        def group_of(r: dict) -> str:
            who = _counterpart(r.get("participants") or [], r.get("direction"), me)
            if not who or "@" not in who:
                return "t:" + (r.get("thread_ref") or str(r["id"]))
            dom = who.split("@")[-1]
            return ("p:" + who) if (dom in FREE_MAIL or dom in team) else ("c:" + dom)

        # A meeting note often names nobody by address. The calendar does: the event
        # at the same hour says who the meeting was with, and so which company's reader
        # should have the note beside that company's mail.
        cal_who: list[tuple[datetime, str]] = []
        if any((r.get("source") in ("granola", "meet")) and group_of(r).startswith("t:") for r in pool):
            try:
                for c in rows(
                    "select occurred_at, participants, direction from interactions "
                    "where source in ('calendar') and occurred_at > now() - interval '40 days' "
                    "order by occurred_at desc limit 400"):
                    who = _counterpart(c.get("participants") or [], c.get("direction"), me)
                    at = _when(c.get("occurred_at"))
                    if who and "@" in who and at:
                        cal_who.append((at, who))
            except Exception:
                cal_who = []

        def placed(r: dict) -> str:
            g = group_of(r)
            if not g.startswith("t:") or r.get("source") not in ("granola", "meet") or not cal_who:
                return g
            at = _when(r.get("occurred_at"))
            if not at:
                return g
            near = min(cal_who, key=lambda c: abs((c[0] - at).total_seconds()))
            if abs((near[0] - at).total_seconds()) > 75 * 60:
                return g
            dom = near[1].split("@")[-1]
            return ("p:" + near[1]) if (dom in FREE_MAIL or dom in team) else ("c:" + dom)

        groups: dict[str, list[dict]] = {}
        order: list[str] = []
        thread_group: dict[str, str] = {}
        for r in pool:
            g = placed(r)
            # a conversation is never split: it goes with whichever group saw it first
            t = r.get("thread_ref")
            if t:
                g = thread_group.setdefault(t, g)
            if g not in groups:
                groups[g] = []
                order.append(g)
            groups[g].append(r)

        # A reader part-way through a large company carries on with it.
        if reader and not again:
            try:
                mine_before = rows(
                    f"select {cols} from interactions where claimed_by = '{reader}' "
                    "and extracted_at is not null order by occurred_at desc limit 40")
                started = {thread_group.get(m.get("thread_ref") or "", placed(m)) for m in mine_before}
                order = [g for g in order if g in started] + [g for g in order if g not in started]
            except Exception:
                pass

        # While the desk is still empty, hand out the small companies first: each is whole
        # in a handful of messages, so the first loose ends appear in a few minutes and
        # not after a reader has worked through one large account. Nothing is cut short to
        # do this; the large ones follow, each still read whole by one reader.
        early = False
        if not again and len(order) > 3:
            try:
                done_rows = int((rows(
                    "select count(*) as n from interactions where extracted_at is not null "
                    "and triage = 'read'")[0] or {}).get("n") or 0)
                early = done_rows < EARLY_UNTIL
            except Exception:
                early = False
        if early:
            small = [g for g in order if len(groups[g]) <= EARLY_GROUP]
            if small:
                order = small
        cap = EARLY_ROWS if early else max(limit, BATCH_ROWS)

        found = list(again)
        for g in ([] if again else order):
            mine_now = groups[g]
            if found and len(found) + len(mine_now) > (cap + 2 if early else MAX_CLAIM):
                continue
            found += mine_now[:MAX_CLAIM]
            if len(found) >= cap:
                break
        res.remaining = max(0, len(pool) - len(found))

        # long enough to read the batch carefully, and no longer: a reader that vanishes
        # must not keep a company to itself for a quarter of an hour
        until = (datetime.now(timezone.utc)
                 + timedelta(minutes=CLAIM_MIN, seconds=CLAIM_SEC_PER_ROW * len(found))).isoformat()
        claim = {"claimed_until": until, "triage": "read"}
        if reader:
            claim["claimed_by"] = reader
        for r in ([] if again else found):
            try:
                pod.records.update("interactions", r["id"], claim)
            except Exception as exc:
                if "claimed_by" in claim:
                    claim = {"claimed_until": until, "triage": "read"}
                    try:
                        pod.records.update("interactions", r["id"], claim)
                        continue
                    except Exception:
                        pass
                res.errors.append(f"could not claim {str(r['id'])[:8]}: {str(exc)[:80]}")
        # a conversation is read in the order it happened
        found.sort(key=lambda r: (r.get("thread_ref") or str(r["id"]), str(r.get("occurred_at") or "")))

    per_body = max(2500, min(data.body_chars, TOTAL_BODY // max(1, len(found))))
    for r in found:
        parts = r.get("participants") or []
        body = ""
        ref = r.get("body_ref")
        if ref:
            try:
                # a meeting note is read to its last line: next steps sit at the end
                room = 20000 if r.get("source") in ("granola", "meet") else per_body
                body = pod.files.download(ref).decode("utf-8", "replace")[:room]
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

    # What has already been read with these same companies and in these same
    # conversations, one line each. During first run a company is read in one go, so this
    # is usually empty; it matters for mail that arrives later, and for a company too big
    # for one batch.
    threads = sorted({i.thread_ref for i in res.items if i.thread_ref})
    domains = sorted({i.person_email.split("@")[-1] for i in res.items
                      if i.person_email and "@" in i.person_email} - FREE_MAIL
                     - {me.split("@")[-1]})
    seen_earlier: set[str] = set()

    def add_earlier(where: str, limit_rows: int) -> None:
        try:
            got = rows(
                "select id, thread_ref, occurred_at, direction, subject, summary from interactions "
                f"where {where} and extracted_at is not null "
                f"and coalesce(triage, '') <> 'noise' order by occurred_at desc limit {limit_rows}")
        except Exception as exc:
            res.errors.append(f"could not read earlier messages: {str(exc)[:100]}")
            return
        for r in got:
            if str(r["id"]) in seen_earlier:
                continue
            seen_earlier.add(str(r["id"]))
            res.earlier.append(Earlier(
                thread_ref=r.get("thread_ref") or "",
                occurred_at=str(r.get("occurred_at") or "") or None,
                direction=r.get("direction"), subject=r.get("subject"),
                summary=r.get("summary"),
            ))

    if threads:
        quoted = ",".join("'" + t.replace("'", "''") + "'" for t in threads[:40])
        add_earlier(f"thread_ref in ({quoted})", 120)
    for dom in domains[:12]:
        safe = dom.replace("'", "''").replace("%", "")
        add_earlier(f"participants::text ilike '%@{safe}%'", 40)
    res.earlier.sort(key=lambda e: e.occurred_at or "")

    # What is already outstanding with these same people. Word-overlap matching used to
    # decide this and got it wrong whenever the wording differed — "share the hiring
    # decision" and "decide next steps and let him know" are one obligation, and became
    # two rows. So the judgment moves to the agent, and this is what it judges against.
    emails = sorted({i.person_email for i in res.items if i.person_email})
    if emails:
        quoted = ",".join("'" + e.replace("'", "''") + "'" for e in emails[:60])
        same_company = "".join(
            " or p.email ilike '%@" + d.replace("'", "''").replace("%", "") + "'" for d in domains[:12])
        try:
            for r in rows(
                f"select p.email as person_email, l.kind, l.obligation "
                f"from loops l join people p on p.id = l.person_id "
                f"where l.status = 'open' and (p.email in ({quoted}){same_company})"
            ):
                res.already_open.append(ExistingLoop(
                    person_email=r.get("person_email") or "",
                    kind=r.get("kind") or "",
                    obligation=r.get("obligation") or "",
                ))
        except Exception as exc:
            res.errors.append(f"could not read open loops: {str(exc)[:100]}")

    return res
