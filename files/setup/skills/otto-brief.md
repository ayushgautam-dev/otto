---
name: otto-brief
description: "Compose the morning brief, work out what to raise in a recurring meeting, and write the short brief on somebody the person is about to meet for the first time. Use for the daily brief run, before a meeting, or when asked what is coming up, who someone is before a meeting, or what to cover with someone. Covers grounding every line in a real commitment or a named source, and the once-a-day sending rule."
---

# Briefing

Three jobs, same discipline: say only what is true, and only what is useful before the
person walks into something.

---

## The morning brief

Once a day. Compose it, store it, send it — to the person themselves and nobody else.

1. **Today's and tomorrow's meetings** — `fetch_calendar_events` with
   `{"past_days":0,"future_days":1}`.
2. **What is owed** — open commitments on the person's side, with the people they belong
   to.
3. **What is ready and waiting** — `drafts` and `deliverables` with `status = 'pending'`:
   work already prepared that only needs their yes.
4. **Sort what you found into the brief's parts, most useful first.** The person reads
   this on a phone before the day starts.
   - `needs_you` — at most three: the things that go wrong if nothing happens today (a
     promise due, whoever has waited longest, a meeting with something owed). Leave it
     empty if nothing qualifies; never fill it to look busy.
   - `meetings` — one per meeting today: `time`, `title`, the join `link`, `people` (who
     is coming), and `owed` (for anyone attending with something outstanding, what it is,
     stated specifically; empty when nothing is). When somebody attending is being met
     for the first time and has a brief (`people.research` is filled), put its first
     line in `owed` in place of nothing: "First meeting. Head of Ops at Acme; she wrote
     in about the pilot on 3 Oct." Never invent that line; with no brief, say nothing.
   - `ready` — each pending draft or document: who it is for and what it says. A draft
     written as choices (`options` filled, `body` empty) is a decision, not a text: `what`
     is its question and the choices ("Sponsor the Brightline dinner? Replies are written
     for Sponsor it / Pass this time"), `tag` is "your call".
   - `waiting` — what else is open on the person's side, by person.
   - `overdue` — oldest first, with how long in `tag` ("7 days late").
   - `tomorrow` — tomorrow's meetings, the same shape as today's.
   Each item is `who` (the person or company), `what` (one plain sentence) and an
   optional short `tag`. Nothing appears in two parts, except that an overdue item may
   also be one of the three in `needs_you`. Times and dates are the person's own (the
   calendar's timezone), never UTC. No record ids, file paths or links other than a
   meeting's join link.
5. **Lay it out** by calling `render_brief` with those parts, plus `day` ("Monday 12
   October") and `first_name`. It returns `html`, the finished email, and `summary`, the
   counts in words. You do not write HTML yourself, ever.
6. **The subject line** is the short day, a colon, and that `summary`: *"Mon 12 Oct:
   2 meetings, 1 overdue, 3 ready to send"*. No greeting, no "Your brief", no product name.
7. **Store one row** in `briefs`: `{content, source:"auto", composed_on:<YYYY-MM-DD>}`,
   where `content` is the same brief in plain markdown (the app shows it).
8. **Send it from your own address, to the person themselves and nobody else.** You have
   a tool for writing to a pod member, `message_user`; find it with `search_tools`. Call it
   with:
   - `to`: the person's own email address (the one this run belongs to). Never anyone else.
   - `channel`: `email`.
   - `title`: the subject line.
   - the message: the `html` from `render_brief`, exactly as returned, start to finish.
     Do not shorten it, reformat it, wrap it in a code block or add anything around it.
   - `expects_response`: false. It is a brief, not a question.
   - `background_instruction`: *"This was the person's morning brief. If they reply, treat
     it as a request made in chat about what the brief said: load the skill it needs, do
     the work, answer in a few lines. Prepare drafts and invites; send nothing to another
     person unless they said to send it."*
9. **Record it** by calling `send_brief_email` with `{"delivered_by_otto": true,
   "subject": <the subject line>}`. That sends nothing; it writes the line in the activity
   log.

**If your own address cannot carry it** (the tool is missing, refuses, or reports the
person unreachable by email), send it the old way instead: `send_brief_email` with
`{"subject": <the subject line>, "html": <the html from render_brief>}`, which mails the
same email from the person's own mailbox. One or
the other, never both.

**The person can reply to the brief.** A reply arrives as a message to you: treat it as a
request made in chat about what the brief said ("send the one to Priya", "push the 3pm",
"what did I promise Acme?"), do the work, and answer in a few lines. Preparing is yours;
sending to anyone else still needs their word.

**Ground every "what you owe" line in a real commitment.** Never invent one to make a
meeting block look fuller.

**Send once.** If it reports the brief has already gone, or that nothing is composed, say
so and stop — never force a second copy. The promise this product makes is fewer
interruptions, not more.

---

## What to raise next time

Before a recurring meeting, answer the only question that matters: *what should I actually
say when this starts?*

Build it from three things:

- **Still unresolved** — what was raised in an earlier meeting and never landed.
- **Promised and not delivered** — by either side, with how long it has been.
- **New since last time** — something that happened that the other person does not know
  yet, and would want to.

**Write it as three or four lines, each one a thing to say.** Not a status report.

> *Priya's start date — still unconfirmed after two weeks. You said you'd come back on it.*

**What does not belong:** anything already settled, anything purely administrative, and
anything the person would find obvious. If there is genuinely nothing worth raising, say
that in one line. An honest empty agenda is more useful than a padded one.

---

## Before a first meeting

Before a recurring meeting the person has "what to raise". Before a **first** meeting
they need something else: a few lines on who is about to walk in. `first_meetings` lists
the meetings coming up with somebody they have not really met (each with its `guests`),
and says whether a paid lookup key is saved (`has_key`).

Write one brief per guest and save it in that person's `people.research` (create the
person first through `ingest_open_loops` if they are not on record yet: `email`, `name`,
`company_domain`, `relationship: "other"` unless the mail shows what they are). Set
`people.role` and `people.linkedin_url` too when you found them with a source.

**Where the facts come from, in this order:**

1. **The person's own mail and notes.** Read every message with this guest
   (`interactions` whose `participants` hold their address, and the bodies): who wrote
   first and when, who introduced them, what they asked for, what was agreed, their
   signature (role, company, phone). This is the most reliable part and often the most
   useful: *why this meeting exists*.
2. **If `has_key` is true:** call `research_person` with the person's id. It writes what
   it finds to `people.research`; read that, keep its facts, and write the brief over it.
   A paid lookup gives a fuller profile (career, education, company size and funding), so
   the brief may run longer, but only with what it actually returned.
3. **Otherwise, the open web.** Search for the person with their company, and for the
   company itself. Then **open the pages** and read them; a search result's snippet is
   not a source. Use a page only when it is plainly about **this** person: the name
   **and** the company or role from their email match. The company's own site, a profile
   page that names that company, a talk or article that names both. A namesake at another
   company is the commonest mistake here; if you cannot tell two people apart, say that
   nothing certain was found and leave it out.

**Rules that do not bend:**

- **Every fact not read in the person's own mail carries the page it came from**, as a
  link beside it. A fact with no page is not written.
- **Never guess, infer or round up.** No "probably", no "likely leads", no seniority or
  background worked out from a job title. What a page states, at the strength it states it.
- **Work only.** Role, company, what the company does, what they have published or said
  about the subject of this meeting. Nothing about family, health, home, age, politics or
  religion, even where a page offers it.
- **Short.** Without a paid key: about 120 words. With one: up to about 250. A brief that
  takes longer to read than the first two minutes of the meeting has failed.
- **If little is found, say so in one line** and give what the mail shows. A short honest
  brief beats a padded one.
- **Do not restate when the meeting is.** The desk shows its day and time beside the
  brief, in the person's own timezone; the times you read in the ledger are UTC, and a
  weekday worked out by hand is easy to get wrong. When a date from the mail matters
  ("she wrote on 3 Oct"), give the day and month only: no weekday, no clock time.

**The shape, in `people.research`, as markdown:**

```
**Who** — Head of Operations at Acme, there since 2023. [acme.com/team](https://…)
**The company** — Acme runs same-day delivery for pharmacies in six cities. [acme.com](https://…)
**Why this meeting** — She wrote on 3 Oct after Sam's introduction, asking how the pilot would work for 40 stores.
**Worth asking** — How they handle returns today · Who else signs off · What a good first month looks like
```

"Why this meeting" comes from the mail and needs no link. "Worth asking" is at most three
questions that follow from the lines above; leave it out when you have nothing specific.
The first line must stand alone: it is what the morning brief quotes.

Once a brief is written it is not rewritten at every run. Refresh it only when the person
asks, or when a later message changes who the guest is.

