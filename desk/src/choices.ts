import { records } from './lib'

/* A reply that turns on a decision only the person can make (take up a sponsorship, accept
   the terms, say yes to the invitation) arrives as choices: one finished message per real
   answer, "Sponsor it" / "Pass this time", and an empty body. Nothing is shown as ready to
   send until they pick. Picking copies that version into the draft, where it is edited and
   sent like any other; the choices stay on the row, so they can change their mind first.

   Shape, written by the assistant (otto-write, "When the answer is theirs to choose"):
     drafts.options = { question, choices: [{ label, subject, body, kind, meeting }], chosen }
   This file is shared verbatim by both apps. */

export interface Choice {
  label: string
  subject?: string | null
  body?: string | null
  kind?: string | null
  meeting?: unknown
}
export interface Choices { question: string | null; choices: Choice[]; chosen: number | null }

export function asChoices(v: unknown): Choices | null {
  let o = v
  if (typeof o === 'string') { try { o = JSON.parse(o) } catch { return null } }
  if (!o || typeof o !== 'object') return null
  const c = o as { question?: unknown; choices?: unknown; chosen?: unknown }
  const list = (Array.isArray(c.choices) ? c.choices : [])
    .filter((x): x is Choice => !!x && typeof (x as Choice).label === 'string' && !!String((x as Choice).body ?? '').trim())
  if (list.length < 2) return null
  const chosen = typeof c.chosen === 'number' && list[c.chosen] ? c.chosen : null
  return { question: typeof c.question === 'string' && c.question.trim() ? c.question.trim() : null, choices: list, chosen }
}

/** The person has not said which way yet. */
export const awaitingChoice = (v: unknown) => { const c = asChoices(v); return !!c && c.chosen === null }

/** SQL: a pending draft on `d` that is still waiting for the person to pick. */
export const AWAITING_SQL = (d: string) =>
  `(${d}.options is not null and jsonb_typeof(${d}.options->'choices') = 'array' and ${d}.options->>'chosen' is null)`

/** Puts version `i` into the draft. Whatever they typed into the version they are leaving
 *  is kept on that version, so switching back finds it as they left it. */
export async function choose(draftId: string, c: Choices, i: number, leaving?: { subject: string; body: string } | null) {
  const choices = c.choices.map((x, j) => (j === c.chosen && leaving ? { ...x, subject: leaving.subject, body: leaving.body } : x))
  const pick = choices[i]
  const meeting = pick.kind === 'meeting'
  await records.update('drafts', draftId, {
    kind: meeting ? 'meeting' : 'email',
    subject: pick.subject ?? '',
    body: pick.body ?? '',
    meeting: meeting ? pick.meeting ?? null : null,
    options: { question: c.question, choices, chosen: i },
  })
}
