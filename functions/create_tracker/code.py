#input_type_name: TrackerInput
#output_type_name: TrackerResult
#function_name: create_tracker

"""Create a tracker (a board with stages) the first time a real pipeline shows up.

Nobody starts with boards. A tracker is made only when the person's own mail and
meetings show several people or companies moving through the same steps — and then it
is named, and its stages are named, after how THAT person runs the process, not after a
template. One person's "Hiring" is Applied / Assignment / Call / Offer; another has no
hiring at all and a "Vendor onboarding" board instead.

This is the only writer of trackers and stages. It refuses a second tracker with the
same slug (returns the existing one), so calling it twice is harmless.
"""

import re

from pydantic import BaseModel, Field
from lemma_sdk import FunctionContext, Pod

COLORS = ["#7c5cff", "#14b8a6", "#d9922a", "#e8663c", "#3b82f6", "#84a34a"]


class StageIn(BaseModel):
    name: str
    definition: str | None = None     # one line: what has to be true for a card to sit here
    is_terminal: bool = False         # the end states: won/joined, lost/not moving ahead


class TrackerInput(BaseModel):
    name: str                         # in the person's words: "Hiring", "Customer pilots"
    subject: str = "person"           # person | company: what a card on it is
    stages: list[StageIn] = Field(default_factory=list)
    slug: str | None = None


class TrackerResult(BaseModel):
    slug: str = ""
    created: bool = False
    stages_created: int = 0
    note: str = ""


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")[:40]


async def create_tracker(ctx: FunctionContext, data: TrackerInput) -> TrackerResult:
    pod = ctx.pod or Pod.from_env()
    slug = _slug(data.slug or data.name)
    if not slug:
        return TrackerResult(note="a tracker needs a name")
    stages = [s for s in data.stages if (s.name or "").strip()][:7]
    if len(stages) < 2:
        return TrackerResult(slug=slug, note="a tracker needs at least two stages")

    existing = pod.query("select id, slug, position from tracks").to_dict()["items"]
    if any(r.get("slug") == slug for r in existing):
        return TrackerResult(slug=slug, note="that tracker already exists; use it")

    position = len(existing)
    track = pod.table("tracks").create({
        "slug": slug, "name": data.name.strip()[:60],
        "card_shape": "organisation" if data.subject.strip().lower().startswith("comp") else "individual",
        "position": position, "color": COLORS[position % len(COLORS)], "archived": False,
    })
    made = 0
    for i, s in enumerate(stages):
        pod.table("stages").create({
            "track_id": track["id"], "name": s.name.strip()[:40],
            "definition": (s.definition or "").strip()[:300] or None,
            "position": i, "is_terminal": bool(s.is_terminal),
        })
        made += 1
    return TrackerResult(slug=slug, created=True, stages_created=made)
