import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useCurrentUser } from 'lemma-sdk/react'
import { Check, PenLine, Plus, Sparkles, X, ArrowUpRight } from 'lucide-react'
import { Avatar, Avatars, Empty, Inline, Loading, Markdown, useToast } from '../ui'
import { useNav } from '../nav'
import { useSql, rev, client } from '../lib'
import { tm } from '../teammate'
import { getSetting, putSetting, runWorkflow } from '../backfill'
import {
  ABOUT, VOICE, BUSINESS, UPDATES, SEC, readText, writeText, parse, render, withEdit, lastUpdated,
  foldEdits, asEdits, findSec, toLines, fromLines, plain, splitLead, splitPerson,
  type Wiki as WikiDoc, type Edits,
} from '../wiki'

/* Your wiki: what the assistant understands about you, written from your mail and meetings
   and kept current every night.

   It reads as a profile, not a document: who you are at the top, what matters now as cards
   that open the matter, the people who matter as faces that open the person, then how you
   work and what you have asked for. Every line is its own thing: fix it, remove it, or add
   one, in place. A line you wrote carries a small mark, because the nightly pass keeps
   your words word for word (settings.wiki_edits) and does not bring back a line you removed.
   How you write sits apart: your own rules (edited as one note) above what was learned from
   your sent mail. The log of what changed is folded away at the foot. */

type Person = { id: string; name: string; email: string | null; avatar_url: string | null; company: string; domain: string | null }
type Company = { id: string; name: string; domain: string | null }
type Stream = { id: string; title: string }

function Logo({ name, domain }: { name: string; domain?: string | null }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="logo">
      {domain && !broken ? <img src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`} alt="" onError={() => setBroken(true)} /> : (name || '?')[0]}
    </span>
  )
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/* ---------------- one line, edited in place ---------------- */

function LineInput({ initial, placeholder, onDone }: {
  initial: string; placeholder?: string; onDone: (text: string | null) => void
}) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [v])
  return (
    <div className="wl-input">
      <textarea ref={ref} autoFocus rows={1} value={v} placeholder={placeholder}
        onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone(null)
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onDone(v) }
        }} />
      <div className="wl-input-foot">
        <span>Enter to save · Esc to cancel</span>
        <button className="link-q" onClick={() => onDone(null)}>Cancel</button>
        <button className="btn primary" onClick={() => onDone(v)}>Save</button>
      </div>
    </div>
  )
}

function Line({ text, mine, onSave, onRemove, className = '', children }: {
  text: string; mine: boolean; className?: string; children: ReactNode
  onSave: (t: string) => void; onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return <LineInput initial={text} onDone={(t) => { setEditing(false); if (t !== null && t.trim() !== text) (t.trim() ? onSave(t.trim()) : onRemove()) }} />
  }
  return (
    <div className={`wl ${className}`}>
      <div className="wl-body">
        {children}
        {mine && <span className="wl-mine" title={`You wrote this. ${tm()} keeps it word for word.`}>yours</span>}
      </div>
      <span className="wl-act">
        <button title="Edit this line" onClick={(e) => { e.stopPropagation(); setEditing(true) }}><PenLine size={13} /></button>
        <button title="Remove this line" onClick={(e) => { e.stopPropagation(); onRemove() }}><X size={14} /></button>
      </span>
    </div>
  )
}

function AddLine({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (t: string) => void }) {
  const [on, setOn] = useState(false)
  if (on) return <LineInput initial="" placeholder={placeholder} onDone={(t) => { setOn(false); if (t?.trim()) onAdd(t.trim()) }} />
  return <button className="wl-add" onClick={() => setOn(true)}><Plus size={13} /> {label}</button>
}

/** A section's lines with edit, remove and add wired to one save. */
function useLines(body: string | undefined, save: (lines: string[], what: string) => void) {
  const lines = useMemo(() => toLines(body ?? ''), [body])
  return {
    lines,
    edit: (i: number) => (t: string) => save(lines.map((l, j) => (j === i ? t : l)), 'Saved'),
    remove: (i: number) => () => save(lines.filter((_, j) => j !== i), `Removed. ${tm()} won't bring it back`),
    add: (t: string) => save([...lines, t], 'Added'),
  }
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="wiki-sec">
      <div className="wiki-sec-h"><h2>{title}</h2>{sub && <span>{sub}</span>}</div>
      {children}
    </section>
  )
}

/* ---------------- whole notes (your writing rules, business details) ---------------- */

function Note({ title, sub, body, hint, onSave, children }: {
  title: string; sub?: string; body: string; hint?: string; onSave: (text: string) => Promise<void>; children?: ReactNode
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  async function save() {
    if (draft === null) return
    setSaving(true)
    try { await onSave(draft); setDraft(null) }
    catch (e) { toast(`Not saved: ${(e as Error)?.message ?? 'try again'}`) }
    finally { setSaving(false) }
  }
  return (
    <section className="wiki-note">
      <div className="wiki-sec-h">
        <h2>{title}</h2>{sub && <span>{sub}</span>}
        {draft === null && <button className="link-q" onClick={() => setDraft(body)}><PenLine size={12} /> Edit</button>}
      </div>
      {draft === null
        ? (body.trim() ? <div className="wiki-body"><Markdown text={body} /></div> : <p className="wiki-none">{hint ?? 'Nothing here yet.'}</p>)
        : (
          <div className="wiki-edit">
            <textarea autoFocus value={draft} rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save() }} />
            <div className="wiki-edit-foot">
              <button className="link-q" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}
      {children}
    </section>
  )
}

/* ---------------- the page ---------------- */

export function Wiki() {
  const toast = useToast()
  const { openSheet: open, version } = useNav()
  const { user } = useCurrentUser({ client })
  const myEmail = ((user as { email?: string } | undefined)?.email ?? '').toLowerCase()
  const [about, setAbout] = useState<WikiDoc | null | undefined>(undefined)
  const [edits, setEdits] = useState<Edits | null>(null)
  const [rules, setRules] = useState('')
  const [learned, setLearned] = useState<string | null>(null)
  const [business, setBusiness] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLDetailsElement>(null)

  const people = useSql<Person>(rev(
    `select p.id, p.name, lower(p.email) as email, p.avatar_url, coalesce(c.name,'') as company, lower(c.domain) as domain
     from people p left join companies c on c.id = p.company_id`, version))
  const companies = useSql<Company>(rev(`select id, name, lower(domain) as domain from companies`, version))
  const streams = useSql<Stream>(rev(
    `select id, title from work_projects where (archived=false or archived is null) and coalesce(kind,'') <> 'account'`, version))

  const load = useCallback(async () => {
    const [a, r, v, b, e] = await Promise.all([
      readText(ABOUT), getSetting('voice_doc').catch(() => null), readText(VOICE), readText(BUSINESS),
      getSetting('wiki_edits').catch(() => null),
    ])
    setAbout(a ? parse(a) : null)
    setRules(r?.value ?? '')
    setLearned(v)
    setBusiness(b)
    setEdits(asEdits(e?.value))
  }, [])
  useEffect(() => { void load() }, [load])

  async function writeNow() {
    setWriting(true)
    try {
      const done = await runWorkflow('autopilot_wiki', 6 * 60_000)
      await load()
      if (!done) toast(`${tm()} is still writing it. It will be here when you come back`)
    } catch { toast('That couldn’t be started just now') }
    finally { setWriting(false) }
  }

  /** Writes one section back as bullets, logs the change, and records which words are
   *  theirs so the nightly pass keeps them and revises only its own. */
  async function saveSection(heading: string, lines: string[], said: string) {
    if (!about) return
    const prevAbout = about
    const prevEdits = edits
    const before = findSec(about, heading)?.body ?? ''
    const after = fromLines(lines)
    const base = findSec(about, heading) ? about : {
      ...about,
      sections: [...about.sections.filter((s) => s.heading !== UPDATES), { heading, body: '' }, ...about.sections.filter((s) => s.heading === UPDATES)],
    }
    const real = findSec(base, heading)!.heading
    const next = withEdit(base, real, after)
    setAbout(next)
    try {
      await writeText(ABOUT, render(next))
      const folded = foldEdits(edits, before, after)
      setEdits(folded)
      await putSetting('wiki_edits', JSON.stringify(folded)).catch(() => null)
      toast(said, said.startsWith('Removed') ? async () => {
        setAbout(prevAbout)
        await writeText(ABOUT, render(prevAbout))
        setEdits(prevEdits)
        await putSetting('wiki_edits', JSON.stringify(prevEdits ?? { wrote: [], deleted: [] })).catch(() => null)
      } : undefined)
    } catch (e) {
      setAbout(prevAbout)
      toast(`Not saved: ${(e as Error)?.message ?? 'try again'}`)
    }
  }

  const mineSet = useMemo(() => new Set((edits?.wrote ?? []).map(plain)), [edits])
  const isMine = (l: string) => mineSet.has(plain(l))

  // who and what a line is about, from the names already in the pod
  const findPerson = useCallback((name: string): Person | null => {
    const n = name.trim().toLowerCase()
    if (!n) return null
    const all = people.items
    const exact = all.filter((p) => p.name.toLowerCase() === n)
    if (exact.length === 1) return exact[0]
    const first = all.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]
      && (n.split(/\s+/).length === 1 || p.name.toLowerCase().endsWith(n.split(/\s+/).slice(-1)[0])))
    return first.length === 1 ? first[0] : null
  }, [people.items])
  const findCompany = useCallback((text: string | null): Company | null => {
    if (!text) return null
    const t = norm(text)
    return companies.items.find((c) => norm(c.name).length >= 3 && t.includes(norm(c.name))) ?? null
  }, [companies.items])
  const findStream = useCallback((text: string): Stream | null => {
    const t = norm(text)
    return streams.items.find((s) => norm(s.title).length >= 4 && t.includes(norm(s.title))) ?? null
  }, [streams.items])

  const who = useLines(about ? findSec(about, SEC.who)?.body : '', (ls, s) => void saveSection(SEC.who, ls, s))
  const now = useLines(about ? findSec(about, SEC.now)?.body : '', (ls, s) => void saveSection(SEC.now, ls, s))
  const ppl = useLines(about ? findSec(about, SEC.people)?.body : '', (ls, s) => void saveSection(SEC.people, ls, s))
  const work = useLines(about ? findSec(about, SEC.work)?.body : '', (ls, s) => void saveSection(SEC.work, ls, s))
  const prefs = useLines(about ? findSec(about, SEC.prefs)?.body : '', (ls, s) => void saveSection(SEC.prefs, ls, s))

  const known = new Set([...Object.values(SEC), UPDATES].map((h) => h.toLowerCase()))
  const others = about?.sections.filter((s) => !known.has(s.heading.toLowerCase())) ?? []
  const log = about ? findSec(about, UPDATES) : undefined
  const logLines = toLines(log?.body ?? '')
  const updated = about ? lastUpdated(about) : null
  const me = people.items.find((p) => p.email && p.email === myEmail)
  const name = about?.title || me?.name || (user as { name?: string } | undefined)?.name || 'You'

  function openLog() {
    setShowLog(true)
    window.setTimeout(() => logRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
  }

  if (about === undefined) return <div className="page wiki"><Loading /></div>

  if (about === null) {
    return (
      <div className="page wiki">
        <h1>Wiki</h1>
        <div className="sub">What {tm()} knows about you</div>
        {writing
          ? <div className="writing" role="status"><span className="spinner sm" /><div><b>{tm()} is writing it…</b><span>From your mail and meetings. You can carry on.</span></div></div>
          : <Empty line={`${tm()} writes this from your mail and meetings, then keeps it current every night.`}
              action={<button className="btn primary lg" onClick={() => void writeNow()}><Sparkles size={13} /> Write it now</button>} />}
      </div>
    )
  }

  return (
    <div className="page wiki">
      {/* who you are: the identity card */}
      <header className="wiki-id">
        <Avatar name={name} src={me?.avatar_url} large />
        <div className="wiki-id-main">
          <div className="wiki-eyebrow">What {tm()} knows about you</div>
          <h1>{name}</h1>
          <div className="wiki-id-lines">
            {who.lines.map((l, i) => (
              <Line key={`${i}-${l}`} text={l} mine={isMine(l)} onSave={who.edit(i)} onRemove={who.remove(i)} className={i === 0 ? 'lede' : ''}>
                <Inline text={l} />
              </Line>
            ))}
            <AddLine label="Add something about you" placeholder="e.g. You lead the platform team at Northwind" onAdd={who.add} />
          </div>
          <div className="wiki-meta">
            <span>{tm()} keeps this current every night{updated ? ` · updated ${updated}` : ''}</span>
            {logLines.length > 0 && <button className="link-q" onClick={openLog}>What changed</button>}
          </div>
        </div>
      </header>

      {/* what matters now: one card per matter */}
      <Section title={SEC.now} sub="This month">
        <div className="wiki-now">
          {now.lines.map((l, i) => {
            const { lead, rest } = splitLead(l)
            const stream = findStream(lead ?? l)
            const company = stream ? null : findCompany(lead ?? l.slice(0, 80))
            return (
              <Line key={`${i}-${l}`} text={l} mine={isMine(l)} onSave={now.edit(i)} onRemove={now.remove(i)} className="now-card">
                <div className="now-h">
                  {company && <Logo name={company.name} domain={company.domain} />}
                  <b>{lead ?? <Inline text={l} />}</b>
                </div>
                {lead && <p className="now-rest"><Inline text={rest} /></p>}
                {(stream || company) && (
                  <button className="now-open" onClick={() => open(stream ? { type: 'workstream', id: stream.id } : { type: 'company', id: company!.id })}>
                    Open {stream ? 'workstream' : company!.name} <ArrowUpRight size={12} />
                  </button>
                )}
              </Line>
            )
          })}
        </div>
        <AddLine label="Add what matters" placeholder="e.g. Hiring a founding designer: two finalists, decision by Friday" onAdd={now.add} />
      </Section>

      {/* the people who matter: faces that open the person */}
      <Section title={SEC.people}>
        <div className="wiki-people">
          {ppl.lines.map((l, i) => {
            const p = splitPerson(l)
            const group = p.names.length > 1 ? p.names.map((n) => findPerson(n) ?? { id: '', name: n, avatar_url: null }) : null
            const one = group ? null : findPerson(p.name)
            const company = group ? null : findCompany(p.org ?? one?.company ?? null)
            return (
              <Line key={`${i}-${l}`} text={l} mine={isMine(l)} onSave={ppl.edit(i)} onRemove={ppl.remove(i)} className="person-row">
                <span className="pr-face">
                  {group
                    ? <Avatars people={group} max={4} onPick={(id) => open({ type: 'person', id })} />
                    : <Avatar name={one?.name ?? p.name} src={one?.avatar_url} large onClick={one ? () => open({ type: 'person', id: one.id }) : undefined} />}
                </span>
                <span className="pr-text">
                  {p.name
                    ? (
                      <span className="pr-name">
                        {one ? <button onClick={() => open({ type: 'person', id: one.id })}>{p.name}</button> : <b>{p.name}</b>}
                        {p.org && (
                          <span className="pr-org">
                            {company && <Logo name={company.name} domain={company.domain} />}
                            {company ? <button onClick={() => open({ type: 'company', id: company.id })}>{p.org}</button> : p.org}
                          </span>
                        )}
                      </span>
                    ) : null}
                  <span className="pr-about"><Inline text={p.about} /></span>
                </span>
              </Line>
            )
          })}
        </div>
        <AddLine label="Add someone" placeholder="e.g. Mira Shah, Acme: your champion for the pilot" onAdd={ppl.add} />
      </Section>

      {/* how you work, and what you have asked for */}
      <div className="wiki-pair">
        <Section title={SEC.work}>
          <div className="wiki-list">
            {work.lines.map((l, i) => (
              <Line key={`${i}-${l}`} text={l} mine={isMine(l)} onSave={work.edit(i)} onRemove={work.remove(i)} className="dot">
                <Inline text={l} />
              </Line>
            ))}
          </div>
          <AddLine label="Add a habit" placeholder="e.g. No meetings before 11 on Mondays" onAdd={work.add} />
        </Section>
        <Section title={SEC.prefs} sub={`${tm()} follows these`}>
          <div className="wiki-list">
            {prefs.lines.map((l, i) => (
              <Line key={`${i}-${l}`} text={l} mine={isMine(l)} onSave={prefs.edit(i)} onRemove={prefs.remove(i)} className="rule">
                <Check size={13} className="rule-ic" /><span><Inline text={l} /></span>
              </Line>
            ))}
          </div>
          <AddLine label="Add a preference" placeholder="e.g. Don't raise newsletters or receipts" onAdd={prefs.add} />
        </Section>
      </div>

      {/* anything else the file holds, line by line */}
      {others.map((s) => <Other key={s.heading} heading={s.heading} body={s.body} isMine={isMine} save={saveSection} />)}

      {/* how you write: your rules, then what was learned */}
      <Note title="How you write" sub={`${tm()} follows your rules over anything it learned`} body={rules}
        hint="Your own rules: greeting, sign-off, words you never use."
        onSave={async (t) => { await putSetting('voice_doc', t.trim()); setRules(t.trim()) }}>
        {learned && (
          <details className="wiki-learned">
            <summary>Learned from your sent mail</summary>
            <div className="wiki-body"><Markdown text={learned.replace(/^#\s.*\n/, '')} /></div>
            <p className="wiki-none">Relearned every month. To change something here, add a rule above.</p>
          </details>
        )}
      </Note>

      {business && (
        <Note title="Business details" sub="Used on invoices and letters" body={business.replace(/^#\s.*\n/, '').trim()}
          onSave={async (t) => {
            const head = /^#\s.*\n/.exec(business)?.[0] ?? ''
            await writeText(BUSINESS, `${head}${head ? '\n' : ''}${t.trim()}\n`)
            setBusiness(`${head}${head ? '\n' : ''}${t.trim()}\n`)
          }} />
      )}

      {logLines.length > 0 && (
        <details ref={logRef} className="wiki-log" open={showLog} onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}>
          <summary>What {tm()} changed recently <span>{logLines.length}</span></summary>
          <ul>{logLines.map((l, i) => {
            const m = /^([^:]{1,12}):\s*(.+)$/.exec(l)
            return <li key={i}>{m ? <><time>{m[1]}</time><span><Inline text={m[2]} /></span></> : <span><Inline text={l} /></span>}</li>
          })}</ul>
        </details>
      )}
    </div>
  )
}

function Other({ heading, body, isMine, save }: {
  heading: string; body: string; isMine: (l: string) => boolean
  save: (heading: string, lines: string[], said: string) => Promise<void>
}) {
  const s = useLines(body, (ls, said) => void save(heading, ls, said))
  return (
    <Section title={heading}>
      <div className="wiki-list">
        {s.lines.map((l, i) => (
          <Line key={`${i}-${l}`} text={l} mine={isMine(l)} onSave={s.edit(i)} onRemove={s.remove(i)} className="dot">
            <Inline text={l} />
          </Line>
        ))}
      </div>
      <AddLine label="Add a line" placeholder="" onAdd={s.add} />
    </Section>
  )
}
