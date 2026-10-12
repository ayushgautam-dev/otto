---
name: otto-brief
description: "Compose the morning brief, and work out what to raise in a recurring meeting. Use for the daily brief run, before a meeting, or when asked what is coming up or what to cover with someone. Covers grounding every line in a real commitment and the once-a-day sending rule."
---

# Briefing

Two jobs, same discipline: say only what is true, and only what is useful before the
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
4. **Compose it in markdown, most useful first.** The person reads this on a phone before
   the day starts, so the top three lines have to be worth it on their own.
   - **Needs you today** — at most three lines: the things that go wrong if nothing
     happens today (a promise due, someone waiting longest, a meeting with something
     owed). Each one names the person and the thing. Leave the section out if nothing
     qualifies; never fill it to look busy.
   - **One block per meeting today:** time, title, who is coming, and for each attendee
     with something outstanding, what it is, stated specifically. If nothing is
     outstanding, say "nothing outstanding".
   - **Ready to send** — each pending draft or document in one line: who it is for and
     what it says. They can approve it by replying.
   - **Overdue** at the bottom, oldest first, with how long it has been.
   - Close with: *"Nothing else will interrupt you today."*
   - If there are no meetings, say so plainly. With nothing waiting either, keep the
     whole brief to three lines.
   - Times and dates are the person's own (the calendar's timezone), never UTC.
5. **Write the subject line** so the email is worth opening, or not, from the inbox
   alone: the day, then what is inside, counted. *"Mon 12 Oct: 3 meetings, 2 overdue,
   1 draft waiting"*. Leave out anything that is zero; on an empty day, *"Mon 12 Oct:
   nothing waiting on you"*. No greeting, no "Your brief", no product name.
6. **Store one row** in `briefs`: `{content, source:"auto", composed_on:<YYYY-MM-DD>}`.
7. **Send it from your own address, to the person themselves and nobody else.** You have
   a tool for writing to a pod member, `message_user`; find it with `search_tools`. Call it
   with:
   - `to`: the person's own email address (the one this run belongs to). Never anyone else.
   - `channel`: `email`.
   - `title`: the subject line.
   - the brief as the message, ending with one line: *"Reply to this email to act on
     anything above, for example 'send the draft to Priya' or 'move the 3pm to tomorrow'."*
   - `expects_response`: false. It is a brief, not a question.
   - `background_instruction`: *"This was the person's morning brief. If they reply, treat
     it as a request made in chat about what the brief said: load the skill it needs, do
     the work, answer in a few lines. Prepare drafts and invites; send nothing to another
     person unless they said to send it."*
8. **Record it** by calling `send_brief_email` with `{"delivered_by_otto": true,
   "subject": <the subject line>}`. That sends nothing; it writes the line in the activity
   log.

**If your own address cannot carry it** (the tool is missing, refuses, or reports the
person unreachable by email), send it the old way instead: `send_brief_email` with
`{"subject": <the subject line>}`, which mails it from the person's own mailbox. One or
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



