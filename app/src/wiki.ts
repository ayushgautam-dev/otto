import { client } from './lib'

/* The person's wiki: what the assistant understands about them, in their own folder.
   - /me/about.md      written by the assistant (a nightly autopilot, and once when first run
                       finishes): who you are, what matters now, how you work, the people who
                       matter, preferences, and a short log of recent updates. The person
                       edits any section here, and their edits win (the autopilot keeps them).
   - settings.voice_doc their own rules for how they write; these beat anything learned.
   - /me/voice.md      how they write, learned from their sent mail. Relearned every month,
                       so it is shown, not edited: a change goes in their rules instead.
   - /me/business.md   official details for invoices and letters, kept from documents sent.
   - settings.wiki_edits the lines the person wrote and the lines they deleted, so the nightly
                       pass can tell their words from its own: it keeps the first word for word
                       and does not bring the second back.
   This file is shared verbatim by both apps. */

export const ABOUT = '/me/about.md'
export const VOICE = '/me/voice.md'
export const BUSINESS = '/me/business.md'
export const UPDATES = 'Recent updates'

export interface Section { heading: string; body: string }
export interface Wiki { title: string | null; sections: Section[] }

type Files = {
  download: (p: string) => Promise<Blob>
  update: (p: string, o: { file: Blob }) => Promise<unknown>
  upload: (f: Blob, o: { name?: string; directoryPath?: string }) => Promise<unknown>
}
const files = () => client.files as unknown as Files

/** The file's text, or null when there is none yet. */
export async function readText(path: string): Promise<string | null> {
  try {
    const t = await (await files().download(path)).text()
    return t.trim() ? t : null
  } catch { return null }
}

export async function writeText(path: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: 'text/markdown' })
  try { await files().update(path, { file: blob }); return } catch { /* not there yet */ }
  const at = path.lastIndexOf('/')
  await files().upload(blob, { name: path.slice(at + 1), directoryPath: path.slice(0, at) || '/' })
}

export function parse(md: string): Wiki {
  let title: string | null = null
  const sections: Section[] = []
  let cur: Section | null = null
  for (const line of md.replace(/\r/g, '').split('\n')) {
    const h1 = /^#\s+(.+)$/.exec(line)
    const h2 = /^##\s+(.+)$/.exec(line)
    if (h1 && !cur && title === null) { title = h1[1].trim(); continue }
    if (h2) { cur = { heading: h2[1].trim(), body: '' }; sections.push(cur); continue }
    if (cur) cur.body += `${line}\n`
  }
  for (const s of sections) s.body = s.body.trim()
  return { title, sections }
}

export function render(w: Wiki): string {
  const head = w.title ? `# ${w.title}\n\n` : ''
  return head + w.sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}\n`).join('\n')
}

const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** Replaces one section with the person's own words, and logs it, newest first. */
export function withEdit(w: Wiki, heading: string, body: string): Wiki {
  const sections = w.sections.map((s) => (s.heading === heading ? { ...s, body: body.trim() } : s))
  const line = `- ${today()}: you changed ${heading}`
  const log = sections.find((s) => s.heading === UPDATES)
  if (log) log.body = [line, ...log.body.split('\n').filter((l) => l.trim())].slice(0, 12).join('\n')
  else sections.push({ heading: UPDATES, body: line })
  return { ...w, sections }
}

/** The newest date in the update log, as written ("14 Oct"), for "updated …". */
export function lastUpdated(w: Wiki): string | null {
  const log = w.sections.find((s) => s.heading === UPDATES)
  const m = log && /^-\s*([^:]+):/m.exec(log.body)
  return m ? m[1].trim() : null
}

export interface Edits { wrote: string[]; deleted: string[] }
const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter((l) => l && !/^#/.test(l))

/** Folds one save into what is known of the person's own words: lines they added or
 *  reworded count as theirs, lines they took out count as deleted. Newest first, capped. */
export function foldEdits(prev: Edits | null, before: string, after: string): Edits {
  const was = new Set(lines(before))
  const now = new Set(lines(after))
  const wrote = lines(after).filter((l) => !was.has(l))
  const gone = lines(before).filter((l) => !now.has(l))
  const keep = (xs: string[], cap: number) => [...new Set(xs)].slice(0, cap)
  const p = prev ?? { wrote: [], deleted: [] }
  return {
    wrote: keep([...wrote, ...p.wrote.filter((l) => !gone.includes(l))], 80),
    deleted: keep([...gone, ...p.deleted.filter((l) => !wrote.includes(l))], 80),
  }
}

/* ---------------- one line at a time ----------------
   The file is bullets under fixed headings (the nightly pass writes it that way). The page
   shows and edits it line by line, so here a section's body becomes a list of lines and
   back. A wrapped bullet stays one line; stray prose becomes a line of its own. */

export const SEC = {
  who: 'Who you are', now: 'What matters now', work: 'How you work',
  people: 'People who matter', prefs: 'Preferences',
} as const

export const findSec = (w: Wiki, heading: string) =>
  w.sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/

export function toLines(body: string): string[] {
  const out: string[] = []
  let open = false
  for (const raw of body.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) { open = false; continue }
    if (BULLET.test(raw)) { out.push(raw.replace(BULLET, '').trim()); open = true; continue }
    if (open && /^\s+/.test(raw)) out[out.length - 1] += ` ${raw.trim()}`
    else { out.push(raw.trim()); open = false }
  }
  return out.filter(Boolean)
}

export const fromLines = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`).join('\n')

/** The same text with its bullet and spacing removed, for telling lines apart. */
export const plain = (l: string) => l.replace(BULLET, '').replace(/\s+/g, ' ').trim()

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "Lead: the rest" / "Lead — the rest" → a short title and its detail, when the lead is short. */
export function splitLead(line: string): { lead: string | null; rest: string } {
  const m = /^(.{3,70}?)(?::\s|\s[—–]\s)(.+)$/.exec(line)
  return m ? { lead: m[1].replace(/[*_`]/g, '').trim(), rest: cap(m[2].trim()) } : { lead: null, rest: line }
}

/** "Priya Nair, Brightline: renewing…" → name, where they are, and what is current.
 *  "Omar, Lena and Dev — your team…" is a group: each name, no organisation. */
export function splitPerson(line: string): { name: string; org: string | null; about: string; names: string[] } {
  const { lead, rest } = splitLead(line)
  if (!lead) return { name: '', org: null, about: line, names: [] }
  if (/\s(?:and|&)\s/.test(lead)) {
    return { name: lead, org: null, about: rest, names: lead.split(/,\s*|\s+(?:and|&)\s+/).map((n) => n.trim()).filter(Boolean) }
  }
  const [name, ...org] = lead.split(/,\s*/)
  return { name: name.trim(), org: org.join(', ').trim() || null, about: rest, names: [name.trim()] }
}

export function asEdits(v: string | null | undefined): Edits | null {
  try { const o = JSON.parse(v || ''); return { wrote: o.wrote ?? [], deleted: o.deleted ?? [] } } catch { return null }
}
