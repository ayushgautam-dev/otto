import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Plus, FileText, CalendarPlus, Send, Check, Video, Clock, ArrowDownUp } from 'lucide-react'
import { useCurrentUser } from 'lemma-sdk/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useSql, records, runFn, rev, lit, isGmailThread, isOutlookThread, client } from './lib'
import { useAccounts, useThreadAccount, accountLabel } from './accounts'
import { Avatar, Markdown, Orb, useToast, countBlanks } from './ui'
import { ART_SELECT, artType, kindLabel, type ArtRow } from './artifacts'
import { useNav } from './nav'
import { tm } from './teammate'
import { asChoices, choose, type Choices } from './choices'

/* What Lem prepared, drawn as the thing itself: a letter, an invitation, a document.
   You read it the way the other person will, change what you want, press one button.
   Every send is your click, held for a few seconds so it can be taken back.
   The send paths (`send_draft`, `send_invite`, `save_google_doc`) and the bookkeeping
   after a send are the existing app's, unchanged. */

export interface DraftRow {
  id: string
  loop_id?: string | null
  to_person_id?: string | null
  kind?: string | null
  subject?: string | null
  body?: string | null
  to_emails?: unknown
  cc_emails?: unknown
  meeting?: unknown
  note?: string | null
  status?: string | null
  person?: string | null
  person_email?: string | null
  avatar_url?: string | null
  thread_ref?: string | null
  obligation?: string | null
  /** set when the reply turns on a decision only the person can make (see choices.ts) */
  options?: unknown
  [k: string]: unknown
}

/** A document, sheet or deck prepared with the draft (see artifacts.tsx). */
export type DocRow = ArtRow

interface Slot { start: string; end?: string }
interface Meeting { title?: string; duration_min?: number; attendees?: string[]; location?: string; slots?: Slot[] }

const DRAFT_SELECT = `
  select d.id, d.loop_id, d.to_person_id, d.kind, d.subject, d.body, d.to_emails, d.cc_emails,
         d.meeting, d.note, d.status, d.options, coalesce(p.name,'') as person, p.email as person_email,
         p.avatar_url, l.thread_ref, l.obligation
  from drafts d
  left join people p on p.id = d.to_person_id
  left join loops l on l.id = d.loop_id`

export const draftById = (id: string) => `${DRAFT_SELECT} where d.id = ${lit(id)} limit 1`
export const draftForLoop = (loopId: string) =>
  `${DRAFT_SELECT} where d.loop_id = ${lit(loopId)} and d.status = 'pending' order by d.created_at desc limit 1`

/* ---------------- small pieces ---------------- */

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.trim()) {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map(String) } catch { /* plain text */ }
    return v.split(/[,;\s]+/).filter((x) => x.includes('@'))
  }
  return []
}

export function asMeeting(v: unknown): Meeting | null {
  if (!v) return null
  if (typeof v === 'string') { try { return JSON.parse(v) as Meeting } catch { return null } }
  return v as Meeting
}

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim())

/** An email is plain text. Markdown the writer slipped in (bold stars, # headings, [links](…))
 *  would reach the other person as literal symbols, so it is taken out before it is shown:
 *  a heading becomes its own line, a link its words and address. "- " lists stay, and the
 *  send turns them into real bullets. */
export function plainEmail(text: string): string {
  return (text || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '$1')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => a ?? b)
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/^(\s*)[*+•]\s+/gm, '$1- ')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`))
}

function usePeopleByEmail(emails: string[]) {
  const key = emails.map((e) => e.toLowerCase()).sort().join(',')
  const q = useSql<{ email: string; name: string; avatar_url?: string | null }>(
    emails.length
      ? `select lower(email) as email, name, avatar_url from people
         where lower(email) in (${emails.map((e) => lit(e.toLowerCase())).join(',')})`
      : null)
  return useMemo(() => {
    const m = new Map<string, { name: string; avatar_url?: string | null }>()
    for (const r of q.items) m.set(r.email, { name: r.name, avatar_url: r.avatar_url })
    return m
  }, [q.items, key])
}

/** The line Lem writes above what it prepared. */
export function LemNote({ text }: { text?: string | null }) {
  if (!text) return null
  return (
    <div className="lemnote">
      <Orb size={14} />
      <span>{text}</span>
    </div>
  )
}

/* Who to write to, from the people already known. Everyone with an address can come up,
   not only the team: most mail that matters goes outside the company. The ones written to
   or met with most in the last months come first, as in any mail app, then teammates. */
const FREE_MAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|aol)\./i
interface Known { email: string; name: string; avatar_url?: string | null; company?: string | null; [k: string]: unknown }

function useKnownPeople(typed: string, skip: string[]) {
  const { user } = useCurrentUser({ client })
  const me = String((user as { email?: string } | undefined)?.email ?? '').toLowerCase()
  const team = me.includes('@') && !FREE_MAIL.test(me) ? me.split('@')[1] : ''
  const t = typed.trim().toLowerCase().replace(/[%_\\]/g, '')
  const q = useSql<Known>(t
    ? `select lower(p.email) as email, p.name, p.avatar_url, coalesce(c.name,'') as company
       from people p left join companies c on c.id = p.company_id
       where p.email like '%@%.%'
         and (lower(p.name) like ${lit(`${t}%`)} or lower(p.name) like ${lit(`% ${t}%`)} or lower(p.email) like ${lit(`${t}%`)})
       order by (select count(*) from interactions i where i.person_id = p.id
                   and i.occurred_at > now() - interval '180 days') desc,
                ${team ? `(lower(p.email) like ${lit(`%@${team}`)}) desc,` : ''} p.name
       limit 12`
    : null)
  return q.items.filter((p) => !skip.includes(p.email)).slice(0, 6)
}

const DRAG = 'application/x-otto-recipient'

function Recipients({ label, emails, onChange, moveTo, onMove, onTake, onDragging, taken = [] }: {
  label: string; emails: string[]; onChange: (next: string[]) => void
  /** already on the other line, so not offered here */
  taken?: string[]
  /** the other line an address can go to ("Cc" from To, "To" from Cc), by its button or by dragging */
  moveTo?: string; onMove?: (email: string) => void
  /** an address dragged here from the other line */
  onTake?: (email: string) => void
  onDragging?: (on: boolean) => void
}) {
  const people = usePeopleByEmail(emails)
  const [adding, setAdding] = useState(false)
  const [val, setVal] = useState('')
  const [hi, setHi] = useState(0)
  const [over, setOver] = useState(false)
  const known = useKnownPeople(adding ? val : '', [...emails, ...taken])
  useEffect(() => { setHi(0) }, [val])
  const add = (e: string) => { if (!emails.includes(e)) onChange([...emails, e]); setVal('') }
  const commit = () => {
    const v = val.trim().toLowerCase()
    if (isEmail(v)) add(v)
    setVal(''); setAdding(false)
  }
  const pick = (p: Known) => { add(p.email); setAdding(true) }
  return (
    <div className={`rcpt${over ? ' over' : ''}`}
      onDragOver={(e) => { if (onTake && e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); setOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={(e) => {
        setOver(false)
        const got = e.dataTransfer.getData(DRAG)
        if (!got || !onTake) return
        const { email, from } = JSON.parse(got) as { email: string; from: string }
        if (from !== label) { e.preventDefault(); onTake(email) }
      }}>
      <span className="rcpt-k">{label}</span>
      <div className="rcpt-list">
        {emails.map((e) => {
          const p = people.get(e.toLowerCase())
          return (
            <span key={e} className="rcpt-chip" title={e} draggable={!!onMove}
              onDragStart={(ev) => { ev.dataTransfer.setData(DRAG, JSON.stringify({ email: e, from: label })); ev.dataTransfer.effectAllowed = 'move'; onDragging?.(true) }}
              onDragEnd={() => onDragging?.(false)}>
              <Avatar name={p?.name || e} src={p?.avatar_url} size="xs" />
              <span>{p?.name || e}</span>
              {onMove && moveTo && (
                <button className="rcpt-mv" title={`Move to ${moveTo}`} aria-label={`Move ${e} to ${moveTo}`} onClick={() => onMove(e)}>
                  <ArrowDownUp size={11} />
                </button>
              )}
              <button aria-label={`Remove ${e}`} onClick={() => onChange(emails.filter((x) => x !== e))}><X size={11} /></button>
            </span>
          )
        })}
        {adding ? (
          <span className="rcpt-add-wrap">
            <input
              autoFocus className="rcpt-in" value={val} placeholder="Name or email"
              onChange={(e) => setVal(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && known.length) { e.preventDefault(); setHi((h) => (h + 1) % known.length) }
                if (e.key === 'ArrowUp' && known.length) { e.preventDefault(); setHi((h) => (h - 1 + known.length) % known.length) }
                if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
                  if (e.key === 'Tab' && !val.trim()) return
                  e.preventDefault()
                  if (known[hi] && !isEmail(val)) pick(known[hi]); else commit()
                }
                if (e.key === 'Backspace' && !val && emails.length) onChange(emails.slice(0, -1))
                if (e.key === 'Escape') { e.stopPropagation(); setVal(''); setAdding(false) }
              }}
            />
            {known.length > 0 && (
              <span className="rcpt-sug" role="listbox">
                {known.map((p, i) => (
                  <button key={p.email} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''}
                    onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(p)}>
                    <Avatar name={p.name || p.email} src={p.avatar_url} size="xs" />
                    <span className="rcpt-sug-t"><b>{p.name || p.email}</b><small>{p.email}{p.company ? ` · ${p.company}` : ''}</small></span>
                  </button>
                ))}
              </span>
            )}
          </span>
        ) : (
          <button className="rcpt-add" onClick={() => setAdding(true)} aria-label={`Add ${label}`}><Plus size={12} /></button>
        )}
      </div>
    </div>
  )
}

/** Hold a send for a few seconds so it can be taken back. Nothing has left until the count ends.
 *  The send fires from the interval itself, never a state updater (StrictMode replays those). */
function useHeldSend(seconds = 6) {
  const [left, setLeft] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  const action = useRef<(() => Promise<void>) | null>(null)
  const count = useRef(0)
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current) }, [])
  function start(run: () => Promise<void>) {
    if (timer.current) return
    action.current = run
    count.current = seconds
    setLeft(seconds)
    timer.current = window.setInterval(() => {
      count.current -= 1
      if (count.current > 0) { setLeft(count.current); return }
      if (timer.current) window.clearInterval(timer.current)
      timer.current = null
      setLeft(null)
      const go = action.current
      action.current = null
      if (go) void go()
    }, 1000)
  }
  function cancel() {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = null; action.current = null; setLeft(null)
  }
  return { left, start, cancel, seconds }
}

function HeldButton({ held, label, icon, disabled, onGo }: {
  held: ReturnType<typeof useHeldSend>; label: string; icon: React.ReactNode; disabled?: boolean; onGo: () => void
}) {
  if (held.left !== null) {
    return (
      <button className="send held" onClick={held.cancel} style={{ ['--p' as string]: `${(held.left / held.seconds) * 100}%` }}>
        <span className="held-bar" /> Sending in {held.left}s · <b>Undo</b>
      </button>
    )
  }
  return <button className="send" disabled={disabled} onClick={onGo}>{icon} {label}</button>
}

async function closeAfterSend(d: DraftRow, sent: string) {
  const now = new Date().toISOString()
  // the answer they picked goes on the record with it, so it is never guessed again
  const c = asChoices(d.options)
  const how = c && c.chosen !== null ? `${sent}: ${c.choices[c.chosen].label}` : sent
  await records.update('drafts', d.id, { status: 'sent', subject: d.subject ?? '', body: d.body ?? '' })
  if (d.loop_id) {
    await records.update('loops', d.loop_id, {
      status: 'closed', closed_at: now, closed_by: 'manual', close_reason: how,
    })
  }
  if (d.to_person_id) {
    try {
      await records.create('timeline_events', {
        person_id: d.to_person_id, type: 'email', source: 'email', title: how, happened_at: now,
        ref: d.thread_ref || null,
      })
    } catch { /* the send is what matters */ }
  }
}

/* ---------------- a letter ---------------- */

/** Sending a rendered file as a real attachment is built but not switched on: it has not been tried with a real send. */
const FILE_ATTACHMENTS = false
const fileOf = (d: DocRow) => (FILE_ATTACHMENTS && typeof d.file_path === 'string' && d.file_path.startsWith('/') ? d.file_path : '')

function docAsHtml(d: DocRow): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const inner = renderToStaticMarkup(<Markdown text={d.body ?? ''} breaks />)
  const link = d.doc_url ? `<p><a href="${esc(d.doc_url)}">Open in Google Docs</a></p>` : ''
  return `<p style="color:#777;font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 6px">Attached</p>`
    + `<h2 style="font-size:18px;margin:0 0 12px">${esc(d.title)}</h2>${link}${inner}`
}

export function Letter({ draft, onSent, docs = [], onEdit, attach: held_, onAttach }: {
  draft: DraftRow; onSent?: () => void; docs?: DocRow[]
  /** which documents go with it, when the pane around it keeps that (its cards toggle it too) */
  attach?: string[]; onAttach?: (ids: string[]) => void
  /** told of every change to the subject and text (the choices keep each version's edits) */
  onEdit?: (subject: string, body: string) => void
}) {
  const toast = useToast()
  const { bump } = useNav()
  const initialTo = asList(draft.to_emails)
  const [to, setTo] = useState<string[]>(initialTo.length ? initialTo : draft.person_email ? [draft.person_email] : [])
  const [cc, setCc] = useState<string[]>(asList(draft.cc_emails))
  const [showCc, setShowCc] = useState(asList(draft.cc_emails).length > 0)
  const [subject, setSubject] = useState(draft.subject ?? '')
  const [body, setBody] = useState(plainEmail(draft.body ?? ''))
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>(draft.status === 'sent' ? 'sent' : 'idle')
  const held = useHeldSend()
  const [own, setOwn] = useState<string[]>(docs.map((d) => d.id))
  useEffect(() => { if (!held_) setOwn(docs.map((d) => d.id)) }, [docs.map((d) => d.id).join(',')])
  const attach = held_ ?? own
  const setAttach = (f: (a: string[]) => string[]) => { const next = f(attach); if (onAttach) onAttach(next); else setOwn(next) }
  // nothing leaves with a blank still in it: the email's own, or a document going with it
  const going = docs.filter((d) => attach.includes(d.id))
  const blanks = countBlanks(body) + going.reduce((n, d) => n + countBlanks(d.body), 0)
  const blankWhere = [countBlanks(body) ? 'the email' : '', ...going.filter((d) => countBlanks(d.body)).map((d) => `the ${kindLabel(d).toLowerCase()}`)].filter(Boolean)
  const area = useRef<HTMLTextAreaElement>(null)
  const isReply = isGmailThread(draft.thread_ref)
  /* Which mailbox it leaves from. A reply goes from the mailbox its conversation is in;
     new mail from the primary, unless the person picks another. Shown only when they
     have more than one. */
  const accounts = useAccounts()
  const threadAccount = useThreadAccount(isReply ? draft.thread_ref : null)
  const [fromId, setFromId] = useState<string | null>(null)
  const from = isReply
    ? threadAccount ?? (isOutlookThread(draft.thread_ref) ? accounts.mail.find((a) => a.provider === 'outlook') ?? null : null)
    : accounts.mail.find((a) => a.id === fromId) ?? accounts.primary
  const who = draft.person || to[0] || ''
  const [dragging, setDragging] = useState(false)
  const move = (e: string, toCc: boolean) => {
    if (toCc) { setTo((t) => t.filter((x) => x !== e)); setCc((c) => (c.includes(e) ? c : [...c, e])); setShowCc(true) }
    else { setCc((c) => c.filter((x) => x !== e)); setTo((t) => (t.includes(e) ? t : [...t, e])) }
  }

  /* Rewritten by the teammate while it is open (a redo, or a change asked for in the chat): show
     the new version. Asking for a rewrite means wanting it, so unsent edits here give way. */
  const stored = [draft.subject ?? '', draft.body ?? '', asList(draft.to_emails).join(','), asList(draft.cc_emails).join(',')].join('\u0000')
  const seen = useRef(stored)
  useEffect(() => {
    if (seen.current === stored) return
    seen.current = stored
    setSubject(draft.subject ?? '')
    setBody(plainEmail(draft.body ?? ''))
    const t = asList(draft.to_emails)
    if (t.length) setTo(t)
    const c = asList(draft.cc_emails)
    setCc(c)
    if (c.length) setShowCc(true)
  }, [stored])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 160)}px`
  }, [body])
  useEffect(() => { onEdit?.(subject, body) }, [subject, body])

  async function reallySend() {
    setState('sending')
    const filed = docs.find((d) => attach.includes(d.id) && fileOf(d))
    try {
      const out = await runFn<{ sent?: boolean; error?: string; mode?: string }>('send_draft', {
        draft_id: draft.id, subject, body,
        to_email: to[0], extra_to: to.slice(1), cc, thread_ref: draft.thread_ref ?? '',
        to_name: draft.person ?? '',
        account_id: from?.id ?? null, provider: from?.provider ?? null,
        // the first document that exists as a file goes as a real attachment; any others,
        // and documents that are only text, are written into the email
        attachment_path: filed ? fileOf(filed) : null,
        appendix_html: docs.filter((d) => attach.includes(d.id) && d.id !== filed?.id).map(docAsHtml).join('<hr style="margin:24px 0">') || null,
      })
      if (!out?.sent) {
        setState('idle')
        toast(out?.error ? `Not sent — ${out.error}` : 'Not sent. Your mailbox refused it')
        return
      }
      await closeAfterSend({ ...draft, subject, body },
        `You ${out.mode === 'reply' ? 'replied to' : 'wrote to'} ${draft.person || to[0]}`)
      setState('sent')
      toast(out.mode === 'reply' ? `Replied to ${draft.person || to[0]}` : `Sent to ${draft.person || to[0]}`)
      bump(); onSent?.()
    } catch (e) {
      setState('idle')
      toast(`Not sent — ${(e as Error)?.message ?? 'something went wrong'}`)
    }
  }

  async function discard() {
    await records.update('drafts', draft.id, { status: 'skipped' })
    toast('Draft discarded', async () => { await records.update('drafts', draft.id, { status: 'pending' }); bump() })
    bump()
  }

  if (state === 'sent') {
    return <div className="letter sent"><Check size={15} /> Sent to {who}</div>
  }

  return (
    <div className="letter">
      <div className="letter-head">
        <span className="letter-k">{isReply ? 'Reply' : 'New email'}</span>
        {!showCc && <button className="link-q" onClick={() => setShowCc(true)}>Cc</button>}
      </div>
      {accounts.multi && from && (
        <div className="letter-from">
          <span className="letter-from-k">From</span>
          {isReply
            ? <span>{accountLabel(from)}</span>
            : (
              <select value={from.id} onChange={(e) => setFromId(e.target.value)} aria-label="Send from">
                {accounts.mail.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
              </select>
            )}
        </div>
      )}
      <Recipients label="To" emails={to} onChange={setTo} moveTo="Cc" onMove={(e) => move(e, true)} onTake={(e) => move(e, false)} onDragging={setDragging} taken={cc} />
      {(showCc || dragging) && <Recipients label="Cc" emails={cc} onChange={setCc} moveTo="To" onMove={(e) => move(e, false)} onTake={(e) => move(e, true)} onDragging={setDragging} taken={to} />}
      {isReply
        ? (subject ? <div className="letter-subj ro">{subject}</div> : null)
        : <input className="letter-subj" value={subject} placeholder="Subject" onChange={(e) => setSubject(e.target.value)} />}
      <textarea ref={area} className="letter-body" value={body} onChange={(e) => setBody(e.target.value)} />
      {docs.length > 0 && (
        <div className="attach-row">
          {docs.map((d) => attach.includes(d.id) ? (
            <span key={d.id} className="attach-f">
              <span className={`attach-b ${artType(d)}`}>{artType(d) === 'sheet' ? 'SHEET' : artType(d) === 'deck' ? 'SLIDES' : 'DOC'}</span>
              <span className="attach-t">
                <b>{d.title}</b>
                <small>{fileOf(d) ? 'Attached as a PDF' : 'Written into the email, under your note'}</small>
              </span>
              <button className="icon-btn" aria-label={`Leave out ${d.title}`} onClick={() => setAttach((a) => a.filter((x) => x !== d.id))}><X size={12} /></button>
            </span>
          ) : (
            <button key={d.id} className="link-q" onClick={() => setAttach((a) => [...a, d.id])}><Plus size={12} /> Include {d.title}</button>
          ))}
        </div>
      )}
      {blanks > 0 && (
        <p className="blank-note">
          {blanks === 1 ? 'One blank is' : `${blanks} blanks are`} still open in {blankWhere.join(' and ')}. Fill {blanks === 1 ? 'it' : 'them'} before sending.
        </p>
      )}
      <div className="letter-foot">
        <button className="link-q" onClick={() => void discard()}>Discard</button>
        <span className="grow" />
        {/* somebody known by name only (a promise from a call): their address is still to come */}
        {!to.length && <span className="muted" style={{ fontSize: 12.5 }}>Add {(draft.person || '').split(' ')[0] || 'their'}{draft.person ? '’s' : ''} address above to send</span>}
        <HeldButton held={held} disabled={state === 'sending' || !to.length || !body.trim() || blanks > 0}
          icon={<Send size={13} />} label={state === 'sending' ? 'Sending…' : isReply ? `Send reply` : 'Send'}
          onGo={() => held.start(reallySend)} />
      </div>
    </div>
  )
}

/* ---------------- an invitation ---------------- */

function slotParts(s: Slot, dur: number) {
  const a = new Date(s.start)
  const b = s.end ? new Date(s.end) : new Date(a.getTime() + dur * 60000)
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return {
    dow: a.toLocaleDateString(undefined, { weekday: 'short' }),
    date: a.getDate(),
    mon: a.toLocaleDateString(undefined, { month: 'short' }),
    day: a.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    time: `${t(a)} – ${t(b)}`,
  }
}

function localStamp(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function Invitation({ draft, onSent }: { draft: DraftRow; onSent?: () => void }) {
  const toast = useToast()
  const { bump } = useNav()
  const m = asMeeting(draft.meeting) ?? {}
  const dur = Number(m.duration_min) || 30
  const slots = (m.slots ?? []).filter((s) => s?.start && !Number.isNaN(Date.parse(s.start)))
  const [pick, setPick] = useState(0)
  const [guests, setGuests] = useState<string[]>(
    asList(m.attendees).length ? asList(m.attendees) : draft.person_email ? [draft.person_email] : [])
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>(draft.status === 'sent' ? 'sent' : 'idle')
  const held = useHeldSend()
  const title = m.title || draft.subject || 'Meeting'

  async function reallySend() {
    const s = slots[pick]
    if (!s) return
    setState('sending')
    try {
      const out = await runFn<{ sent?: boolean; error?: string; link?: string }>('send_invite', {
        title, start: localStamp(s.start), duration_min: dur,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attendees: guests, description: draft.body ?? '',
      })
      if (!out?.sent) {
        setState('idle')
        toast(out?.error ? `Invite not sent — ${out.error}` : 'Invite not sent')
        return
      }
      const when = slotParts(s, dur)
      await closeAfterSend(draft, `Invite sent for ${when.day}, ${when.time}`)
      setState('sent')
      toast(`Invite sent — ${when.day}, ${when.time}`)
      bump(); onSent?.()
    } catch (e) {
      setState('idle')
      toast(`Invite not sent — ${(e as Error)?.message ?? 'something went wrong'}`)
    }
  }

  if (state === 'sent') return <div className="letter sent"><Check size={15} /> Invite sent</div>

  return (
    <div className="letter invite">
      <div className="letter-head"><span className="letter-k">Invitation</span></div>
      <div className="inv-title">{title}</div>
      <div className="inv-meta">
        <span><Clock size={12} /> {dur} min</span>
        <span><Video size={12} /> {m.location || 'Google Meet'}</span>
      </div>
      {slots.length === 0
        ? <p className="muted" style={{ margin: '10px 0' }}>No free times found. Ask {tm()} for more.</p>
        : (
          <div className="slots" role="radiogroup">
            {slots.map((s, i) => {
              const p = slotParts(s, dur)
              return (
                <button key={i} role="radio" aria-checked={pick === i}
                  className={`slot${pick === i ? ' on' : ''}`} onClick={() => setPick(i)}>
                  <span className="slot-cal"><small>{p.dow}</small><b>{p.date}</b><small>{p.mon}</small></span>
                  <span className="slot-t">{p.time}</span>
                </button>
              )
            })}
          </div>
        )}
      <Recipients label="Guests" emails={guests} onChange={setGuests} />
      <div className="letter-foot">
        <span className="grow" />
        <HeldButton held={held} disabled={!slots.length || !guests.length || state === 'sending'}
          icon={<CalendarPlus size={13} />} label={state === 'sending' ? 'Sending…' : 'Send invite'}
          onGo={() => held.start(reallySend)} />
      </div>
    </div>
  )
}

/* ---------------- pick the right shape ---------------- */

interface Carry { attach?: string[]; onAttach?: (ids: string[]) => void }

export function Prepared({ draft, onSent, docs, onDirect, attach, onAttach }: Carry & {
  draft: DraftRow; onSent?: () => void; docs?: DocRow[]
  /** "Something else": the person says which way in their own words and the assistant writes it */
  onDirect?: (direction: string) => void
}) {
  const c = asChoices(draft.options)
  if (c) return <Decided draft={draft} c={c} onSent={onSent} docs={docs} onDirect={onDirect} attach={attach} onAttach={onAttach} />
  return <Shaped draft={draft} onSent={onSent} docs={docs} attach={attach} onAttach={onAttach} />
}

function Shaped({ draft, onSent, docs, onEdit, attach, onAttach }: Carry & { draft: DraftRow; onSent?: () => void; docs?: DocRow[]; onEdit?: (s: string, b: string) => void }) {
  if ((draft.kind ?? '') === 'meeting' && asMeeting(draft.meeting)?.slots?.length) {
    return <Invitation draft={draft} onSent={onSent} />
  }
  return <Letter draft={draft} onSent={onSent} docs={docs} onEdit={onEdit} attach={attach} onAttach={onAttach} />
}

/* ---------------- a decision that is theirs ---------------- */

/* The reply turns on a yes or no only the person can make, and nothing on record says which
   way they went. So it asks first: one button per answer, each already written. Once one is
   picked the letter is that version, and the answers stay above it to switch between. */
function Decided({ draft, c, onSent, docs, onDirect, attach, onAttach }: Carry & {
  draft: DraftRow; c: Choices; onSent?: () => void; docs?: DocRow[]; onDirect?: (direction: string) => void
}) {
  const { bump } = useNav()
  const toast = useToast()
  const edits = useRef<{ subject: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [other, setOther] = useState(false)
  const [say, setSay] = useState('')
  const first = (draft.person || '').split(' ')[0] || 'them'

  async function pick(i: number) {
    if (busy || i === c.chosen) return
    setBusy(true)
    try { await choose(draft.id, c, i, edits.current); edits.current = null; bump() }
    catch (e) { toast(`That didn’t stick: ${(e as Error)?.message ?? 'try again'}`) }
    finally { setBusy(false) }
  }
  function direct() {
    const t = say.trim()
    if (!t || !onDirect) return
    setOther(false); setSay('')
    onDirect(t)
  }

  return (
    <>
      <div className={`choose${c.chosen === null ? ' ask' : ''}`}>
        <div className="choose-q">{c.question || `How do you want to answer ${first}?`}</div>
        <div className="choose-row" role="group" aria-label="Your answer">
          {c.choices.map((x, i) => (
            <button key={i} className={`chip-btn${i === c.chosen ? ' on' : ''}`} aria-pressed={i === c.chosen}
              disabled={busy} onClick={() => void pick(i)}>{x.label}</button>
          ))}
          {onDirect && !other && <button className="link-q" onClick={() => setOther(true)}>Something else</button>}
        </div>
        {other && (
          <div className="choose-say">
            <input autoFocus value={say} placeholder={`Which way? ${tm()} writes it`}
              onChange={(e) => setSay(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') direct(); if (e.key === 'Escape') setOther(false) }} />
            <button className="btn sm line" disabled={!say.trim()} onClick={direct}>Write it</button>
          </div>
        )}
      </div>
      {c.chosen !== null && (
        <Shaped key={`${draft.id}:${c.chosen}`} draft={draft} onSent={onSent} docs={docs} attach={attach} onAttach={onAttach}
          onEdit={(subject, body) => { edits.current = { subject, body } }} />
      )}
    </>
  )
}

/** Referenced from chat by id (`[[draft:…]]` / `[[doc:…]]`): a chip that opens the real
 *  thing in Focus, never pasted into the conversation. */
export function WorkChip({ kind, id }: { kind: 'draft' | 'doc'; id: string }) {
  const { version, open, view } = useNav()
  const d = useSql<DraftRow>(rev(kind === 'draft' ? draftById(id) : null, version))
  const doc = useSql<DocRow>(rev(kind === 'doc'
    ? `select id, title, kind, format, status, loop_id from deliverables where id=${lit(id)} limit 1`
    : null, version))
  if (kind === 'draft') {
    const row = d.items[0]
    if (!row) return null
    const first = (row.person || '').split(' ')[0]
    const meeting = row.kind === 'meeting'
    const c = asChoices(row.options)
    if (c && c.chosen === null && row.status === 'pending') {
      return (
        <button className="workchip" onClick={() => row.loop_id && open({ type: 'loop', id: row.loop_id })}>
          <span className="workchip-ic"><Send size={14} /></span>
          <span className="workchip-t">
            <b>{c.question || `How do you want to answer ${first || 'them'}?`}</b>
            <small>{c.choices.map((x) => x.label).join(' · ')}</small>
          </span>
          <span className="workchip-s">Choose →</span>
        </button>
      )
    }
    return (
      <button className="workchip" onClick={() => row.loop_id && open({ type: 'loop', id: row.loop_id })}>
        <span className="workchip-ic">{meeting ? <CalendarPlus size={14} /> : <Send size={14} />}</span>
        <span className="workchip-t">
          <b>{meeting ? `Proposed times${first ? ` with ${first}` : ''}` : `Email to ${first || 'them'}`}</b>
          {row.subject && <small>{row.subject}</small>}
        </span>
        <span className="workchip-s">{row.status === 'sent' ? 'Sent' : 'Review →'}</span>
      </button>
    )
  }
  const row = doc.items[0]
  if (!row) return null
  return (
    <button className="workchip" onClick={() => view(row.id)}>
      <span className="workchip-ic"><FileText size={14} /></span>
      <span className="workchip-t"><b>{row.title}</b><small>{kindLabel(row)}</small></span>
      <span className="workchip-s">Read →</span>
    </button>
  )
}

export function useDocsForLoop(loopId: string | null) {
  const { version } = useNav()
  return useSql<DocRow>(rev(loopId
    ? `${ART_SELECT} where d.loop_id=${lit(loopId)} and d.status <> 'discarded' order by d.created_at desc limit 3`
    : null, version))
}
