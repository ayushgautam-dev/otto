import { useEffect, useState, useRef } from 'react'
import { X, ExternalLink, MessageCircle, Maximize2, Minimize2, Paperclip, ChevronRight, EyeOff } from 'lucide-react'
import { useCurrentUser } from 'lemma-sdk/react'
import {
  client, sql, useSql, rev, lit, ageLabel, fmtDate, fmtTime, runFn, records,
  type PersonRow, type LoopRow, type TimelineRow,
} from './lib'
import { Avatar, Markdown, Brief, Empty, Loading, useToast } from './ui'
import { useNav, tabKey, type SheetTarget } from './nav'
import { ItemList } from './items'
import { LemPane, useAskLem, useLemPanel } from './asklem'
import { CloseControls } from './closing'
import {
  DraftCard, DocCard, LemNote, draftForLoop, useDocsForLoop, type DraftRow,
} from './cards'

import { tm } from './teammate'
import { useThreadAccount } from './accounts'
import { isGmailThread } from './lib'
import { asChoices } from './choices'
/* The right-hand workspace: a pane of tabs beside the page, never over it. */

/* ---------------- tab labels ---------------- */

function TabLabel({ t }: { t: NonNullable<SheetTarget> }) {
  const q = useSql<{ label: string }>(
    t.type === 'person' ? `select name as label from people where id=${lit(t.id)}`
      : t.type === 'company' ? `select name as label from companies where id=${lit(t.id)}`
      : t.type === 'workstream' ? `select title as label from work_projects where id=${lit(t.id)}`
        : t.type === 'doc' ? `select title as label from deliverables where id=${lit(t.id)}`
          : t.type === 'meeting' ? `select regexp_replace(subject, '^\\s*\\[[^\\]]*\\]\\s*', '') as label from interactions where id=${lit(t.id)}`
          : t.type === 'loop' ? `select coalesce(p.name, '') || '' as label from loops l left join people p on p.id=l.person_id where l.id=${lit(t.id)}`
            : null)
  if (t.type === 'lem') return <><span className="lem-dot sm" aria-hidden><i /></span>{tm()}</>
  const label = q.items[0]?.label || '…'
  return <>{t.type === 'loop' ? `${label.split(' ')[0] || 'Item'} · thread` : label}</>
}

/* ---------------- email conversation ---------------- */

interface Att { filename: string; mime: string; attachment_id: string }
interface ThreadMsg { id: string; from_name: string; from_email: string; date: string; body: string; mine: boolean; subject?: string; attachments?: Att[] }
const threadCache = new Map<string, { subject: string; messages: ThreadMsg[] }>()

export function ThreadView({ threadRef, collapsed = false }: { threadRef: string; collapsed?: boolean }) {
  // which of the person's mailboxes this conversation lives in
  const accountId = useThreadAccount(threadRef)?.id ?? ''
  const [data, setData] = useState(threadCache.get(threadRef) ?? null)
  const [err, setErr] = useState('')
  // null = the default (last two open); a set once the person starts choosing
  const [openIds, setOpenIds] = useState<Set<string> | null>(null)
  const [fetching, setFetching] = useState<string | null>(null)
  // Loaded in the background as soon as the item opens, shown only when asked for.
  const [shown, setShown] = useState(!collapsed)

  useEffect(() => {
    let live = true
    setErr('')
    if (threadCache.has(threadRef)) { setData(threadCache.get(threadRef)!); return }
    runFn<{ subject?: string; messages?: ThreadMsg[]; error?: string }>('get_email_thread', { thread_id: threadRef, account_id: accountId || null })
      .then((out) => {
        if (!live) return
        if (out.error && !out.messages?.length) { setErr(out.error); return }
        const d = { subject: out.subject ?? '', messages: out.messages ?? [] }
        threadCache.set(threadRef, d); setData(d)
      })
      .catch((e) => { if (live) setErr((e as Error)?.message || 'Could not open the conversation') })
    return () => { live = false }
  }, [threadRef, accountId])

  const total = data?.messages.length ?? 0
  const files = data?.messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0) ?? 0
  const bar = (
    <button className="thread-toggle" onClick={() => setShown((v) => !v)} disabled={!data && !err}>
      <ChevronRight size={14} style={{ transform: shown ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
      <span>{shown ? 'Hide conversation' : 'Show conversation'}</span>
      <span className="tt-meta">
        {data ? `${total} message${total === 1 ? '' : 's'}${files ? ` · ${files} attachment${files === 1 ? '' : 's'}` : ''}` : err ? '' : 'loading…'}
      </span>
    </button>
  )
  if (!shown) return bar
  if (err) return <>{bar}<div className="empty" style={{ padding: '10px 0', fontSize: 13 }}>{err}</div></>
  if (!data) return <>{bar}<div className="thread-loading">Opening the conversation…</div></>

  const msgs = data.messages
  const opened = openIds ?? new Set(msgs.slice(-2).map((m) => m.id))
  const toggle = (id: string) => setOpenIds(() => {
    const n = new Set(opened); if (n.has(id)) n.delete(id); else n.add(id); return n
  })
  async function openAttachment(m: ThreadMsg, a: Att) {
    setFetching(a.attachment_id)
    // open the tab now, while we still have the click — a window opened after an await is blocked
    const win = window.open('', '_blank')
    try {
      const out = await runFn<{ content_base64?: string; mime?: string; error?: string }>('get_email_attachment', {
        message_id: m.id, attachment_id: a.attachment_id, file_name: a.filename, account_id: accountId || null })
      if (!out.content_base64) { win?.close(); setErr(out.error || 'Could not open the attachment'); return }
      const bytes = Uint8Array.from(atob(out.content_base64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: a.mime || out.mime || 'application/octet-stream' }))
      if (win) win.location.href = url
      else { const l = document.createElement('a'); l.href = url; l.download = a.filename; l.click() }
    } catch (e) { win?.close(); setErr((e as Error)?.message || 'Could not open the attachment') }
    finally { setFetching(null) }
  }
  return (
    <>{bar}
    <div className="mailthread">
      <div className="mt-subj">
        {data.subject || '(no subject)'}
        <a className="src-go" href={`https://mail.google.com/mail/u/0/#all/${threadRef}`} target="_blank" rel="noreferrer">
          Gmail <ExternalLink size={11} />
        </a>
      </div>
      {msgs.map((m) => {
        const open = opened.has(m.id)
        const d = new Date(m.date)
        const when = Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
        return (
          <div key={m.id} className={`mt-msg${open ? ' open' : ''}`}>
            <div className="mt-h" onClick={() => toggle(m.id)}>
              <Avatar name={m.mine ? 'You' : m.from_name} />
              <span className="mt-from">{m.mine ? 'You' : m.from_name}</span>
              {!open && !!m.attachments?.length && (
                <span className="mt-clipname" title={m.attachments.map((a) => a.filename).join(', ')}>
                  <Paperclip size={11} />
                  {m.attachments[0].filename}{m.attachments.length > 1 ? ` +${m.attachments.length - 1}` : ''}
                </span>
              )}
              <span className="mt-when">{when}</span>
            </div>
            <div className="mt-b" onClick={() => !open && toggle(m.id)}>{open ? m.body : m.body.replace(/\s+/g, ' ').slice(0, 110)}</div>
            {open && !!m.attachments?.length && (
              <div className="mt-atts">
                {m.attachments.map((a) => (
                  <button key={a.attachment_id} className="mt-att" disabled={fetching === a.attachment_id}
                    onClick={() => void openAttachment(m, a)}>
                    <Paperclip size={12} /> {fetching === a.attachment_id ? 'Opening…' : a.filename}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
    </>
  )
}

/* ---------------- an item: its conversation + what Lem prepared ---------------- */

interface LoopFull extends LoopRow { company_id?: string | null }

function LoopPane({ tab }: { tab: Extract<SheetTarget, { type: 'loop' }> }) {
  const { version, bump, closeTab, openSheet } = useNav()
  const toast = useToast()
  const askLem = useAskLem()
  const q = useSql<LoopFull>(rev(
    `select l.id, l.side, l.kind, l.status, l.obligation, l.provenance, l.urgency_reason, l.thread_ref,
            l.opened_at, l.person_id, coalesce(p.name,'') as person, p.email as person_email, p.avatar_url,
            p.company_id
     from loops l left join people p on p.id=l.person_id where l.id=${lit(tab.id)} limit 1`, version))
  const dq = useSql<DraftRow>(rev(draftForLoop(tab.id), version))
  const docs = useDocsForLoop(tab.id)
  const l = q.items[0]
  const draft = dq.items[0]
  const first = (l?.person || 'them').split(' ')[0]
  const isMail = isGmailThread(l?.thread_ref)
  const [making, setMaking] = useState(false)
  // null: closed; otherwise what they want, being typed, before asking for a draft or a redo
  const [say, setSay] = useState<{ redo: boolean; text: string } | null>(null)
  const key = `loop:${tab.id}`

  async function startNudge() {
    if (!l || draft || making) return
    setMaking(true)
    try {
      await records.create('drafts', {
        loop_id: l.id, to_person_id: l.person_id, kind: 'email', status: 'pending',
        subject: '', body: `Hi ${first},\n\n`,
        to_emails: l.person_email ? [l.person_email] : [],
        note: `A nudge to ${first}, on the same conversation. Write it, or let ${tm()}.`,
      })
      bump()
    } finally { setMaking(false) }
  }
  /* Asking for a draft does not bring the chat forward. This pane says it is being
     written for as long as the run lasts, and re-reads every few seconds so the draft
     shows the moment it is there. */
  const panel = useLemPanel()
  const writing = panel.isWriting(key)
  useEffect(() => {
    if (!writing) return
    const t = window.setInterval(bump, 4000)
    return () => window.clearInterval(t)
  }, [writing])
  const autoNudged = useRef(false)
  useEffect(() => {
    if (!tab.nudge || !l || dq.isLoading || autoNudged.current) return
    autoNudged.current = true
    // a nudge opened from the Feed is written straight away, in place
    void (async () => { if (!draft) await startNudge(); lemWrite() })()
  }, [tab.nudge, l?.id, dq.isLoading])

  if (q.isLoading && !l) return <div className="pane-body"><Loading /></div>
  if (!l) return <div className="pane-body"><Empty line="This item is gone." /></div>

  const lemWrite = (direction?: string) => {
    if (!l) return
    const said = direction?.trim() ? ` My direction: "${direction.trim()}".` : ''
    panel.write(
    l.side === 'them'
      ? `Write a short nudge to ${l.person} about "${l.obligation}" (commitment ${l.id}) in my voice, as a reply on the same conversation. Put it in the pending draft for that commitment if there is one.${said} End with the card marker.`
      : `Prepare "${l.obligation}" for me (commitment ${l.id}). Use the otto-write skill and pick the right shape.${said} End with the card marker.`,
    { key, title: l.obligation, about: `the commitment "${l.obligation}" (loop_id ${l.id})` })
  }
  const go = async () => {
    const t = say?.text ?? ''
    setSay(null)
    if (l.side === 'them' && !draft) await startNudge()
    lemWrite(t)
  }

  // a nudge that was started and not written yet holds only its greeting
  const blank = !!draft && (draft.kind ?? 'email') === 'email' && !asChoices(draft.options)
    && String(draft.body ?? '').replace(/^\s*(hi|hello|hey|dear)\b[^\n]*\n?/i, '').trim() === ''
  const hasWork = (!!draft && !(writing && blank)) || docs.items.length > 0
  const written = (!!draft && !blank) || docs.items.length > 0

  const direct = say && (
    <div className="direct">
      <div className="direct-q">{say.redo ? 'What should change?' : `Anything ${tm()} should know?`}</div>
      <textarea autoFocus rows={3} value={say.text}
        placeholder={say.redo ? 'e.g. warmer, shorter, and mention the invoice is attached' : 'e.g. keep it to two lines and offer a call this week'}
        onChange={(e) => setSay({ ...say, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void go() }
          if (e.key === 'Escape') { e.stopPropagation(); setSay(null) }
        }} />
      <div className="direct-foot">
        <span className="direct-hint">Optional. Left empty, {tm()} uses its judgement.</span>
        <span style={{ flex: 1 }} />
        <button className="btn quiet" onClick={() => setSay(null)}>Cancel</button>
        <button className="btn primary" disabled={making} onClick={() => void go()}>{say.redo ? 'Redo' : 'Write it'}</button>
      </div>
    </div>
  )
  const ask = () => panel.open({ key, title: l.obligation, about: `the commitment "${l.obligation}" (loop_id ${l.id})` })

  return (
    <div className="pane-body">
      <div className="lp-head">
        <div className="lp-title">{l.obligation}</div>
        <div className="lp-meta">
          <button className="link" onClick={() => l.person_id && openSheet({ type: 'person', id: l.person_id })}>{l.person}</button>
          {l.opened_at ? ` · ${ageLabel(l.opened_at)}` : ''}
          {l.status !== 'open' ? ` · ${l.status}` : ''}
        </div>
        {l.urgency_reason && <p className="why">{l.urgency_reason}</p>}
      </div>

      <CloseControls loop={l} onClosed={() => { bump(); closeTab(tabKey(tab)) }}>
        {!hasWork && !writing && !say && l.side === 'them' && (
          <button className="btn primary" disabled={making} onClick={() => setSay({ redo: false, text: '' })}>Nudge {first}</button>
        )}
        {!hasWork && !writing && !say && l.side === 'you' && (
          <button className="btn primary" onClick={() => setSay({ redo: false, text: '' })}>Prepare it</button>
        )}
        <button className="btn quiet" onClick={ask}><MessageCircle size={13} /> Ask</button>
      </CloseControls>
      {!hasWork && direct}

      {/* like an email client: the conversation first, your reply underneath it */}
      <div style={{ marginTop: 16 }} />
      {isMail
        ? <ThreadView threadRef={l.thread_ref!} collapsed />
        : <div className="empty" style={{ padding: '4px 0', fontSize: 13, textAlign: 'left' }}>
            {l.provenance || (l.thread_ref?.startsWith('granola:') ? 'From your meeting notes.' : 'No email conversation for this one.')}
          </div>}

      {writing && (
        <div className="writing" role="status">
          <span className="spinner sm" />
          <div><b>{tm()} is {written ? 'rewriting' : 'writing'} it…</b><span>It will appear here. You can carry on.</span></div>
        </div>
      )}
      {hasWork && (
        <div className="prepared" style={{ marginTop: 16 }}>
          {draft && <LemNote text={draft.note} />}
          {draft && <DraftCard draft={draft} docs={docs.items} onSent={() => closeTab(tabKey(tab))} onDirect={(t) => lemWrite(t)} />}
          {say ? direct : (
            <div className="acts" style={{ marginTop: -2, marginBottom: 12 }}>
              <button className="btn quiet" disabled={writing} onClick={() => setSay({ redo: written, text: '' })}>
                <MessageCircle size={13} /> {written ? 'Redo' : `Let ${tm()} write it`}
              </button>
            </div>
          )}
          {docs.items.map((d) => <DocCard key={d.id} doc={d} />)}
        </div>
      )}
    </div>
  )
}

/* ---------------- a person ---------------- */

type Tab = 'overview' | 'timeline' | 'docs' | 'about'

/* The timeline is the story of the relationship, not a log. It keeps meetings that
   happened, what was decided or delivered, promises made and kept (including what you
   closed yourself with a note — "sent the deck on WhatsApp"), and drops the admin:
   invites, accepts, declines, reschedules, and calendar rows a meeting's notes already
   cover. Grouped by month, newest first, one line each; the detail opens on click. */

const NOISE = /(accept|declin|invit|rsvp|resched|calendar notification|waiting in the meet|moved (the|to)|join(ed)? the (call|meet)|reminder)/i

interface Story { id: string; when: string; kind: 'meeting' | 'email' | 'note' | 'done'; title: string; quote?: string | null; cal?: boolean }

function toStory(events: TimelineRow[], closed: { id: string; obligation: string; close_reason?: string | null; closed_at?: string | null; closed_by?: string | null }[]): Story[] {
  const now = Date.now()
  const rows: Story[] = []
  for (const e of events) {
    if (!e.happened_at || Date.parse(e.happened_at) > now) continue          // not yet happened
    if (NOISE.test(e.title)) continue
    const kind: Story['kind'] = e.type === 'loop_closed' ? 'done' : e.type === 'meeting' ? 'meeting' : e.type === 'email' ? 'email' : 'note'
    rows.push({ id: e.id, when: e.happened_at, kind, title: e.title, quote: e.quote, cal: e.source === 'calendar' })
  }
  // promises kept that never got a timeline line of their own
  const said = new Set(rows.filter((r) => r.kind === 'done').map((r) => r.title.slice(0, 40)))
  for (const l of closed) {
    // what YOU did — your own clicks, not Lem's housekeeping over scheduling back-and-forth
    if (!l.closed_at || l.closed_by !== 'manual') continue
    if (/\b(confirm|schedul|reschedul|slot|a time|invite)\b/i.test(l.obligation)) continue
    if (said.has(l.obligation.slice(0, 40))) continue
    const why = l.close_reason && !/^You (marked|said)/.test(l.close_reason) ? ` — ${l.close_reason.charAt(0).toLowerCase()}${l.close_reason.slice(1)}` : ''
    rows.push({ id: `l:${l.id}`, when: l.closed_at, kind: 'done', title: `${l.obligation}${why}` })
  }
  // a bare calendar row next to a meeting with notes (within two days) is the same
  // meeting, often one that moved — keep the one that says what happened
  const bare = (r: Story) => r.kind === 'meeting' && (!!r.cal || !/[—;:]/.test(r.title))
  const rich = rows.filter((r) => r.kind === 'meeting' && !bare(r))
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (bare(r) && rich.some((x) => Math.abs(Date.parse(x.when) - Date.parse(r.when)) < 2.5 * 86400000)) rows.splice(i, 1)
  }
  // one meeting per day: the one with notes beats the bare calendar row
  rows.sort((x, y) => y.when.localeCompare(x.when))
  const out: Story[] = []
  for (const r of rows) {
    const day = r.when.slice(0, 10)
    const twin = out.find((o) => o.kind === r.kind && o.when.slice(0, 10) === day && (r.kind === 'meeting' || o.title.slice(0, 30) === r.title.slice(0, 30)))
    if (twin) { if (r.title.length > twin.title.length) Object.assign(twin, r); continue }
    out.push(r)
  }
  return out
}

const KIND_MARK: Record<Story['kind'], string> = { meeting: 'Met', email: 'Mail', note: 'Note', done: 'Done' }

function StoryView({ items, stands }: { items: Story[]; stands?: string | null }) {
  const [open, setOpen] = useState<string | null>(null)
  const months = new Map<string, Story[]>()
  for (const s of items) {
    const k = new Date(s.when).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    if (!months.has(k)) months.set(k, [])
    months.get(k)!.push(s)
  }
  return (
    <div className="story">
      {stands && (
        <div className="story-now"><span className="cap" style={{ margin: 0 }}>Where you stand</span>
          <p>{(stands.match(/[^.!?]+[.!?]+/g) ?? [stands]).slice(0, 2).join(' ').trim()}</p></div>
      )}
      {items.length === 0 && <Empty line="Nothing worth recording yet." />}
      {[...months.entries()].map(([m, list]) => (
        <section key={m} className="story-m">
          <div className="story-mh">{m}</div>
          {list.map((s) => (
            <div key={s.id} className={`story-r k-${s.kind}`} onClick={() => s.quote && setOpen(open === s.id ? null : s.id)}>
              <span className="story-d">{new Date(s.when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
              <span className="story-k">{KIND_MARK[s.kind]}</span>
              <span className={`story-t${s.quote ? ' has' : ''}`}>
                {s.title}
                {open === s.id && s.quote && <span className="quote" style={{ display: 'block', marginTop: 6 }}>{s.quote}</span>}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function PersonPane({ tab }: { tab: Extract<SheetTarget, { type: 'person' }> }) {
  const { openSheet, version, bump } = useNav()
  const askLem = useAskLem()
  const [view, setView] = useState<Tab>('overview')
  const personId = tab.id

  const q = useSql<PersonRow & { company_id?: string | null }>(rev(
    `select p.id, p.name, p.email, p.role, p.avatar_url, p.context, p.research,
            p.relationship, p.company_id, coalesce(c.name,'') as company
     from people p left join companies c on c.id = p.company_id
     where p.id=${lit(personId)} limit 1`, version))
  const loops = useSql<LoopRow>(rev(
    `select l.id, l.side, l.kind, l.obligation, l.provenance, l.opened_at,
            l.urgency, l.urgency_reason, l.thread_ref, l.person_id, l.source,
            coalesce(p.name,'') as person, p.avatar_url,
            (select count(*) from drafts d where d.loop_id=l.id and d.status='pending') as has_draft,
            (select count(*) from drafts d where d.loop_id=l.id and d.status='pending' and d.options is not null and jsonb_typeof(d.options->'choices') = 'array' and d.options->>'chosen' is null) as needs_call
     from loops l left join people p on p.id=l.person_id
     where l.person_id=${lit(personId)} and l.status='open'
     order by coalesce(l.urgency,2) asc`, version))
  const tl = useSql<TimelineRow>(rev(view === 'timeline'
    ? `select id, type, title, quote, happened_at, source from timeline_events
       where person_id=${lit(personId)} order by happened_at desc nulls last limit 200`
    : null, version))
  const kept = useSql<{ id: string; obligation: string; close_reason?: string; closed_at?: string; closed_by?: string }>(rev(view === 'timeline'
    ? `select id, obligation, close_reason, closed_at, closed_by from loops
       where person_id=${lit(personId)} and status='closed' order by closed_at desc limit 60`
    : null, version))
  const docs = useSql<{ id: string; title: string; created_at?: string }>(rev(view === 'docs'
    ? `select d.id, d.title, d.created_at from deliverables d
       left join tasks t on t.id = d.task_id
       left join loops l on l.id = d.loop_id
       where t.person_id=${lit(personId)} or l.person_id=${lit(personId)}
       order by d.created_at desc limit 40`
    : null, version))

  const p = q.items[0]
  return (
    <div className="pane-body">
      <div className="pp-head">
        <Avatar name={p?.name} src={p?.avatar_url} large />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">{p?.name ?? 'Loading…'}</div>
          <div className="rl">
            {p?.role ? `${p.role} · ` : ''}
            {p?.company && p.company_id
              ? <button className="link" onClick={() => openSheet({ type: 'company', id: p.company_id! })}>{p.company}</button>
              : p?.email}
          </div>
        </div>
        <button className="btn quiet" onClick={() => askLem('', {
          key: `person:${personId}`, title: p?.name ?? 'Person',
          about: p ? `${p.name}${p.company ? ` at ${p.company}` : ''} (person_id ${personId})` : `person_id ${personId}`,
        })}>
          <MessageCircle size={14} /> Ask {tm()}
        </button>
      </div>
      <div className="tabs">
        {(['overview', 'timeline', 'docs', 'about'] as Tab[]).map((t) => (
          <button key={t} className={view === t ? 'on' : ''} onClick={() => setView(t)}>
            {t === 'overview' ? 'Open' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 14 }}>
        {view === 'overview' && (loops.isLoading ? <Loading />
          : loops.items.length === 0 ? <Empty line="Nothing open with them." />
            : <ItemList loops={loops.items} highlight={tab.highlight} onChange={bump} />)}
        {view === 'timeline' && (tl.isLoading ? <Loading />
          : <StoryView items={toStory(tl.items, kept.items)} stands={p?.context} />)}
        {view === 'docs' && (docs.isLoading ? <Loading />
          : docs.items.length === 0 ? <Empty line="Nothing written about them yet." />
            : docs.items.map((d) => (
              <button key={d.id} className="row" onClick={() => openSheet({ type: 'doc', id: d.id })}>
                <span className="nm">{d.title}</span><span className="rt">{fmtDate(d.created_at)}</span>
              </button>)))}
        {view === 'about' && (p?.research || p?.context
          ? (p.research ? <Brief text={p.research} /> : <Markdown text={p.context || ''} />)
          : <Empty line={`${tm()} has not written them up yet.`} />)}
      </div>
    </div>
  )
}

/* ---------------- a company ---------------- */

function CompanyPane({ tab }: { tab: Extract<SheetTarget, { type: 'company' }> }) {
  const { openSheet, version, bump } = useNav()
  const c = useSql<{ id: string; name: string; domain?: string; what?: string; context?: string }>(rev(
    `select id, name, domain, what, context from companies where id=${lit(tab.id)}`, version)).items[0]
  const ws = useSql<{ id: string; title: string; stands?: string; cadence?: string; raise_next?: string }>(rev(
    `select id, title, stands, cadence, raise_next from work_projects where company_id=${lit(tab.id)} and (archived is null or archived=false)`, version)).items[0]
  const people = useSql<PersonRow>(rev(
    `select p.id, p.name, p.email, p.role, p.avatar_url,
            (select count(*) from loops l where l.person_id=p.id and l.status='open') as open_count
     from people p where p.company_id=${lit(tab.id)} order by open_count desc, p.name`, version))
  const loops = useSql<LoopRow>(rev(
    `select l.id, l.side, l.kind, l.obligation, l.provenance, l.opened_at, l.urgency, l.urgency_reason,
            l.thread_ref, l.person_id, l.source, coalesce(p.name,'') as person, p.avatar_url,
            (select count(*) from drafts d where d.loop_id=l.id and d.status='pending') as has_draft,
            (select count(*) from drafts d where d.loop_id=l.id and d.status='pending' and d.options is not null and jsonb_typeof(d.options->'choices') = 'array' and d.options->>'chosen' is null) as needs_call
     from loops l join people p on p.id=l.person_id
     where p.company_id=${lit(tab.id)} and l.status='open' order by coalesce(l.urgency,2)`, version))
  if (!c) return <div className="pane-body"><Loading /></div>
  return (
    <div className="pane-body">
      <div className="pp-head">
        <span className="logo lg">{c.domain ? <img src={`https://www.google.com/s2/favicons?domain=${c.domain}&sz=64`} alt="" /> : c.name[0]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">{c.name}</div>
          <div className="rl">{[ws?.cadence, c.domain].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {(ws?.stands || c.what) && <p className="why" style={{ marginTop: 12 }}>{ws?.stands || c.what}</p>}
      {String(ws?.raise_next ?? '').trim() && String(ws?.raise_next).trim() !== 'Nothing worth raising.' && (
        <div className="raise" style={{ marginTop: 12 }}>
          <div className="cap" style={{ marginBottom: 7 }}>Raise next time</div>
          <Markdown text={String(ws?.raise_next)} />
        </div>
      )}
      <div className="cap" style={{ marginTop: 18 }}>Open</div>
      {loops.items.length ? <ItemList loops={loops.items} onChange={bump} /> : <Empty line="Nothing open with them." />}
      <div className="cap" style={{ marginTop: 18 }}>People</div>
      {people.items.map((p) => (
        <button key={p.id} className="row" onClick={() => openSheet({ type: 'person', id: p.id })}>
          <Avatar name={p.name} src={p.avatar_url} />
          <span style={{ minWidth: 0, flex: 1 }}><span className="nm">{p.name}</span>
            <span className="ds" style={{ display: 'block' }}>{p.role || p.email}</span></span>
          <span className="rt">{Number(p.open_count) > 0 ? `${p.open_count} open` : ''}</span>
        </button>
      ))}
    </div>
  )
}

/* ---------------- a workstream ---------------- */

/** A hiring round, a project or a recurring meeting, opened whole: where it stands, what to
 *  raise next time, everything open in it, the people in it, and its board if it has one. */
function WorkstreamPane({ tab }: { tab: Extract<SheetTarget, { type: 'workstream' }> }) {
  const { openSheet, version, bump } = useNav()
  const w = useSql<{ id: string; title: string; kind?: string; cadence?: string; stands?: string; raise_next?: string; track_id?: string; company_id?: string; last_met_at?: string }>(rev(
    `select id, title, kind, cadence, stands, raise_next, track_id, company_id, last_met_at
     from work_projects where id=${lit(tab.id)} limit 1`, version)).items[0]
  const loops = useSql<LoopRow>(rev(
    `select l.id, l.side, l.kind, l.obligation, l.provenance, l.opened_at, l.due_at, l.urgency, l.urgency_reason,
            l.thread_ref, l.person_id, l.source, coalesce(p.name,'') as person, p.avatar_url,
            (select count(*) from drafts d where d.loop_id=l.id and d.status='pending') as has_draft,
            (select count(*) from drafts d where d.loop_id=l.id and d.status='pending' and d.options is not null and jsonb_typeof(d.options->'choices') = 'array' and d.options->>'chosen' is null) as needs_call
     from loops l left join people p on p.id=l.person_id
     where l.work_project_id=${lit(tab.id)} and l.status='open' order by coalesce(l.urgency,2)`, version))
  const cards = useSql<{ id: string; person_id?: string; name: string; stage: string; pos: number; note?: string }>(rev(w?.track_id
    ? `select b.id, b.person_id, coalesce(p.name, c.name, '—') as name, coalesce(s.name,'—') as stage,
              coalesce(s.position,99) as pos, b.last_move_reason as note
       from board_cards b left join people p on p.id=b.person_id left join companies c on c.id=b.company_id
       left join stages s on s.id=b.stage_id where b.track_id=${lit(w.track_id)} order by s.position nulls last`
    : null, version))
  if (!w) return <div className="pane-body"><Loading /></div>
  const people = Array.from(new Map(loops.items.filter((l) => l.person_id).map((l) => [l.person_id, { id: l.person_id as string, name: l.person, avatar_url: l.avatar_url }])).values())
  const stages = [...new Set(cards.items.map((c) => c.stage))]
  const raise = String(w.raise_next ?? '').trim()
  return (
    <div className="pane-body">
      <div className="pp-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">{w.title}</div>
          <div className="rl">{[...new Set([w.kind === 'hiring' ? 'Hiring round' : w.kind === 'project' ? 'Project' : w.kind === 'meeting' ? 'Recurring meeting' : '', w.cadence].filter(Boolean))].join(' · ')}</div>
        </div>
        {w.company_id && <button className="btn quiet" onClick={() => openSheet({ type: 'company', id: w.company_id! })}>Company</button>}
      </div>
      {w.stands && <p className="why" style={{ marginTop: 4 }}>{w.stands}</p>}
      {raise && raise !== 'Nothing worth raising.' && (
        <div className="raise" style={{ marginTop: 12 }}>
          <div className="cap" style={{ marginBottom: 7 }}>Raise next time</div>
          <Markdown text={raise} />
        </div>
      )}
      <div className="cap" style={{ marginTop: 18 }}>Open</div>
      {loops.items.length ? <ItemList loops={loops.items} onChange={bump} /> : <Empty line="Nothing open." />}
      {people.length > 0 && (
        <>
          <div className="cap" style={{ marginTop: 18 }}>People</div>
          {people.map((p) => (
            <button key={p.id} className="row" onClick={() => openSheet({ type: 'person', id: p.id })}>
              <Avatar name={p.name} src={p.avatar_url} /><span className="nm">{p.name}</span>
            </button>
          ))}
        </>
      )}
      {cards.items.length > 0 && (
        <>
          <div className="cap" style={{ marginTop: 18 }}>Board</div>
          <div className="board"><div className="cols">
            {stages.map((st) => (
              <div key={st}>
                <div className="col-h"><span>{st}</span><span>{cards.items.filter((c) => c.stage === st).length}</span></div>
                {cards.items.filter((c) => c.stage === st).map((c) => (
                  <button key={c.id} className="card" style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => c.person_id && openSheet({ type: 'person', id: c.person_id })}>
                    <div><b>{c.name}</b>{c.note && <small>{c.note}</small>}</div>
                  </button>
                ))}
              </div>
            ))}
          </div></div>
        </>
      )}
    </div>
  )
}

/* ---------------- a meeting ---------------- */

/* A meeting opened from the day's calendar: what to know before walking in (the same
   pane as the desk app). Somebody being met for the first time: the short brief on them,
   or a way to have one written. A recurring meeting: what to raise. Anybody: what is open
   between you. And once it has happened, what the notes say. */

interface MeetRow { id: string; subject: string; occurred_at: string; participants?: unknown; thread_ref?: string | null; external_id?: string | null; triage?: string | null; [k: string]: unknown }
interface GuestRow { id: string; name: string; email: string; role?: string | null; avatar_url?: string | null; research?: string | null; company?: string | null; met: number; [k: string]: unknown }

function attendeesOf(v: unknown): { email: string; name: string }[] {
  let a: unknown = v
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = [] } }
  if (!Array.isArray(a)) return []
  return a.map((p) => ({ email: String((p as { email?: string })?.email ?? '').toLowerCase(), name: String((p as { name?: string })?.name ?? '') }))
    .filter((p) => p.email)
}

const meetingTitle = (t?: string | null) => (t ?? '').replace(/^\s*\[[^\]]*\]\s*/, '').trim()

/* Somebody else can put anything on your calendar. A meeting that is not yours to care about
   is taken off the desk, not off the calendar: its row is marked noise, the same mark mail
   that is not worth reading gets, so nothing reads it, briefs it or shows it, and the next
   calendar sync leaves the mark alone. A series goes whole, and its later occurrences arrive
   already marked (record_interaction). */
async function setMeetingNoise(m: MeetRow, series: boolean, noise: boolean): Promise<string[]> {
  const ids = series && m.thread_ref
    ? (await sql<{ id: string }>(`select id from interactions where source='calendar' and thread_ref=${lit(m.thread_ref)}`)).map((r) => r.id)
    : [m.id]
  await Promise.all(ids.map((id) => records.update('interactions', id, { triage: noise ? 'noise' : null })))
  return ids
}

function MeetingPane({ tab }: { tab: Extract<SheetTarget, { type: 'meeting' }> }) {
  const { openSheet, version, bump, closeTab } = useNav()
  const askLem = useAskLem()
  const panel = useLemPanel()
  const toast = useToast()
  const [removing, setRemoving] = useState(false)
  const { user } = useCurrentUser({ client })
  const myDomain = (((user as { email?: string } | undefined)?.email ?? '').split('@')[1] ?? '').toLowerCase()
  const mq = useSql<MeetRow>(rev(
    `select id, subject, occurred_at, participants, thread_ref, external_id, triage from interactions where id=${lit(tab.id)} limit 1`, version))
  const m = mq.items[0]
  const invited = attendeesOf(m?.participants)
  const inList = invited.length ? invited.map((p) => lit(p.email)).join(',') : null
  const guests = useSql<GuestRow>(rev(inList
    ? `select p.id, p.name, p.email, p.role, p.avatar_url, p.research, coalesce(c.name,'') as company,
              (select count(*) from interactions e where e.source='calendar' and e.occurred_at < now() and coalesce(e.triage,'') <> 'noise'
                 and e.id <> ${lit(tab.id)} and e.participants::text ilike '%' || p.email || '%') as met
       from people p left join companies c on c.id=p.company_id where lower(p.email) in (${inList})`
    : null, version))
  const loops = useSql<LoopRow>(rev(inList
    ? `select l.id, l.side, l.kind, l.obligation, l.provenance, l.opened_at, l.due_at, l.urgency, l.urgency_reason,
              l.thread_ref, l.person_id, l.source, coalesce(p.name,'') as person, p.avatar_url,
              (select count(*) from drafts d where d.loop_id=l.id and d.status='pending') as has_draft,
              (select count(*) from drafts d where d.loop_id=l.id and d.status='pending' and d.options is not null and jsonb_typeof(d.options->'choices') = 'array' and d.options->>'chosen' is null) as needs_call
       from loops l join people p on p.id=l.person_id
       where lower(p.email) in (${inList}) and l.status='open' order by coalesce(l.urgency,2)`
    : null, version))
  const series = useSql<{ id: string; raise_next?: string }>(rev(m
    ? `select id, raise_next from work_projects where coalesce(archived,false)=false and kind='meeting'
         and lower(title)=lower(${lit(meetingTitle(m.subject))}) limit 1`
    : null, version)).items[0]
  const note = useSql<{ id: string; summary?: string | null }>(rev(
    `select id, summary from interactions where meeting_id=${lit(tab.id)} and summary is not null limit 1`, version)).items[0]

  if (mq.isLoading && !m) return <div className="pane-body"><Loading /></div>
  if (!m) return <div className="pane-body"><Empty line="That meeting is no longer on your calendar." /></div>

  const title = meetingTitle(m.subject) || 'Meeting'
  const when = new Date(m.occurred_at)
  const ahead = when.getTime() > Date.now()
  const day = when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const recurring = !!m.thread_ref && !!m.external_id && m.thread_ref !== m.external_id
    && m.thread_ref.split(':').pop() !== m.external_id.split(':').pop()
  const byEmail = new Map(guests.items.map((g) => [g.email.toLowerCase(), g]))
  const outside = invited.filter((p) => !myDomain || p.email.split('@')[1] !== myDomain)
  const briefed = guests.items.filter((g) => (g.research ?? '').trim() && Number(g.met) === 0)
  const unbriefed = recurring ? [] : outside.filter((p) => {
    const g = byEmail.get(p.email)
    return !(g?.research ?? '').trim() && Number(g?.met ?? 0) === 0
  })
  const firstOf = (n: string) => n.split(' ')[0] || n
  const raise = String(series?.raise_next ?? '').trim()
  const removed = m.triage === 'noise'

  async function remove(whole: boolean) {
    setRemoving(false)
    const ids = await setMeetingNoise(m!, whole, true)
    toast(whole ? 'Series removed from your desk' : 'Removed from your desk', async () => {
      await Promise.all(ids.map((id) => records.update('interactions', id, { triage: null })))
      bump()
    })
    bump(); closeTab(tabKey(tab))
  }

  return (
    <div className="pane-body">
      <div className="pp-head meet-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm clamp" title={title}>{title}</div>
          <div className="rl">{day}, {fmtTime(m.occurred_at)}{recurring ? ' · Recurring' : ''}</div>
        </div>
        <button className="btn quiet" onClick={() => panel.open({
          key: `meeting:${m.id}`, title, about: `their meeting "${title}" on ${day} (calendar row ${m.id} in interactions)`,
        })}><MessageCircle size={13} /> Ask {tm()}</button>
        {!removed && (
          <button className="btn quiet" title="Not your meeting? Remove it from your desk. It stays on your calendar."
            aria-label="Remove from your desk" onClick={() => setRemoving((v) => !v)}><EyeOff size={14} /></button>
        )}
      </div>
      {removing && (
        <div className="confirm-strip" role="alertdialog" aria-label="Remove this meeting">
          <div><b>Take it off your desk?</b><span>It stays on your calendar. {tm()} stops showing it and preparing for it.</span></div>
          <div className="confirm-acts">
            <button className="btn quiet" onClick={() => setRemoving(false)}>Cancel</button>
            {recurring && <button className="btn" onClick={() => void remove(true)}>Every one in the series</button>}
            <button className="btn primary" onClick={() => void remove(false)}>{recurring ? 'Just this one' : 'Remove'}</button>
          </div>
        </div>
      )}
      {removed && (
        <div className="confirm-strip">
          <div><b>Off your desk.</b><span>It is still on your calendar; {tm()} leaves it alone.</span></div>
          <div className="confirm-acts">
            <button className="btn" onClick={() => void setMeetingNoise(m, false, false).then(bump)}>Put it back</button>
          </div>
        </div>
      )}

      {briefed.map((g) => (
        <div key={g.id} className="raise" style={{ marginTop: 12 }}>
          <div className="cap" style={{ marginBottom: 7 }}>Before you meet {firstOf(g.name)}</div>
          <Brief text={String(g.research)} />
        </div>
      ))}
      {ahead && unbriefed.length > 0 && briefed.length === 0 && (
        <div className="raise" style={{ marginTop: 12 }}>
          <div className="cap" style={{ marginBottom: 7 }}>
            You haven’t met {unbriefed.map((p) => firstOf(byEmail.get(p.email)?.name || p.name || p.email.split('@')[0])).slice(0, 2).join(' or ')} before
          </div>
          <p className="why" style={{ margin: '0 0 10px' }}>{tm()} can write a few lines on who they are and why you are meeting.</p>
          <button className="btn" onClick={() => askLem(
            `Write the short brief for my meeting "${title}" on ${day}. Run first_meetings with {"meeting_id": "${m.id}"} and follow the brief skill's "Before a first meeting" section. Then tell me in one line that it is ready.`,
            { key: `meeting:${m.id}`, title, about: `their meeting "${title}" on ${day} (calendar row ${m.id} in interactions)` })}>
            Prepare a brief
          </button>
        </div>
      )}
      {raise && raise !== 'Nothing worth raising.' && (
        <div className="raise" style={{ marginTop: 12 }}>
          <div className="cap" style={{ marginBottom: 7 }}>Raise this time</div>
          <Markdown text={raise} />
        </div>
      )}
      {note?.summary && (
        <>
          <div className="cap" style={{ marginTop: 18 }}>From the notes</div>
          <p className="why" style={{ marginTop: 4 }}>{note.summary}</p>
        </>
      )}

      <div className="cap" style={{ marginTop: 18 }}>Open with them</div>
      {loops.items.length ? <ItemList loops={loops.items} onChange={bump} />
        : <Empty line={invited.length ? 'Nothing open with anyone in this meeting.' : 'Nobody else is on this one.'} />}

      {invited.length > 0 && (
        <>
          <div className="cap" style={{ marginTop: 18 }}>Who is coming</div>
          {invited.map((p) => {
            const g = byEmail.get(p.email)
            return g
              ? <button key={p.email} className="row" onClick={() => openSheet({ type: 'person', id: g.id })}>
                  <Avatar name={g.name} src={g.avatar_url} /><span className="nm">{g.name}</span>
                </button>
              : <div key={p.email} className="row">
                  <Avatar name={p.name || p.email} /><span className="nm">{p.name || p.email}</span>
                </div>
          })}
        </>
      )}
    </div>
  )
}

/* ---------------- a document ---------------- */

function DocPane({ tab }: { tab: Extract<SheetTarget, { type: 'doc' }> }) {
  const { version } = useNav()
  const q = useSql<{ id: string; title: string; body: string; doc_url?: string; created_at?: string }>(rev(
    `select id, title, body, doc_url, created_at from deliverables where id=${lit(tab.id)} limit 1`, version))
  const d = q.items[0]
  if (q.isLoading && !d) return <div className="pane-body"><Loading /></div>
  if (!d) return <div className="pane-body"><Empty line="Not found." /></div>
  return (
    <div className="pane-body">
      <DocCard doc={d} open />
    </div>
  )
}

/* ---------------- the pane ---------------- */

export function Pane() {
  const { tabs, sheet, focusTab, closeTab, openSheet } = useNav()
  const [wide, setWide] = useState(false)
  useEffect(() => { document.body.classList.toggle('pane-wide', wide) }, [wide])
  if (!tabs.length || !sheet) return null
  const k = tabKey(sheet)
  return (
    <aside className="pane" aria-label="Workspace">
      <div className="pane-tabs">
        {tabs.map((t) => {
          const tk = tabKey(t)
          return (
            <div key={tk} className={`ptab${tk === k ? ' on' : ''}`}>
              <button className="ptab-l" onClick={() => focusTab(tk)}><TabLabel t={t} /></button>
              <button className="ptab-x" aria-label="Close tab" onClick={() => closeTab(tk)}><X size={12} /></button>
            </div>
          )
        })}
        <span style={{ flex: 1 }} />
        <button className="btn quiet" title={wide ? 'Narrower' : 'Wider'} onClick={() => setWide((v) => !v)}>
          {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="btn quiet" title="Close all" onClick={() => openSheet(null)}><X size={15} /></button>
      </div>
      {/* every open tab stays mounted, so a reply Lem is still writing keeps going and
          nothing is re-sent when you come back to it */}
      {tabs.map((t) => {
        const tk = tabKey(t)
        return (
          <div key={tk} className="pane-slot" style={{ display: tk === k ? 'flex' : 'none' }}>
            {t.type === 'lem' && <LemPane tab={t} />}
            {t.type === 'person' && <PersonPane tab={t} />}
            {t.type === 'company' && <CompanyPane tab={t} />}
            {t.type === 'workstream' && <WorkstreamPane tab={t} />}
            {t.type === 'loop' && <LoopPane tab={t} />}
            {t.type === 'doc' && <DocPane tab={t} />}
            {t.type === 'meeting' && <MeetingPane tab={t} />}
          </div>
        )
      })}
    </aside>
  )
}
