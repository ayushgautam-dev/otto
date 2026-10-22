import {
  createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, Fragment,
  type ReactNode,
} from 'react'
import { useConversationMessages } from 'lemma-sdk/react'
import { ArrowUp, Square, ChevronDown, Plus, X, Minus, History, Check } from 'lucide-react'
import { client, sql, lit, records, useSql, rev, ageLabel } from './lib'
import { Markdown, Orb } from './ui'
import { WorkChip } from './prepared'
import { useNav, type Focus } from './nav'
import { tm } from './teammate'

/* Lem is part of the room, not a tab.

   A command bar sits at the foot of every page. Type into it and it grows upward into
   the conversation, the page still visible above and beside it. Whatever is open in
   Focus rides along as context, shown as a chip you can remove. While Lem works its orb
   breathes — in the bar too, after you've collapsed it — and anything you asked it to
   *do* shows as a live pill that follows you from page to page.

   The conversation plumbing is the existing app's: one `pod_default` conversation per
   scope, remembered in `chat_threads`, created explicitly before the first send. */

export interface ChatScope {
  key: string
  /** One sentence telling Lem what this conversation is about. */
  about: string
  title: string
}

export const HOME: ChatScope = {
  key: 'home',
  about: 'the whole workspace — their people, commitments and workstreams',
  title: '',
}

/* The main conversation is a day's conversation, not one that runs for ever.
   It used to live under the single key "home", so whatever somebody typed on day thirty
   was appended to the very first chat they ever had: slow to open, and Lem answering
   with a month of unrelated turns behind it. Now each day starts a fresh one; earlier
   days stay in the Conversations list under their first line. Nothing is lost by this:
   what Lem knows about the person lives in the pod, not in the chat. Conversations
   opened from an item, a person or a piece of work keep their own key and are unchanged. */
const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const todaysHome = (): ChatScope => ({ ...HOME, key: `home:${dayKey()}` })
const isHome = (key: string) => key === 'home' || key.startsWith('home:')
const CARRY_ON_MS = 2 * 3600_000   // a chat that crosses midnight is not cut in two

/** The main conversation to open now: today's if there is one (or one used in the last
 *  couple of hours), otherwise a new one. */
async function currentHome(): Promise<ChatScope> {
  try {
    const rows = await sql<{ scope_key: string; title: string; last_used_at: string }>(
      `select scope_key, coalesce(title,'') as title, last_used_at from chat_threads
       where scope_key = 'home' or scope_key like 'home:%'
       order by last_used_at desc nulls last limit 1`)
    const t = rows[0]
    if (t?.last_used_at) {
      const at = new Date(t.last_used_at)
      if (dayKey(at) === dayKey() || Date.now() - at.getTime() < CARRY_ON_MS) return { ...HOME, key: t.scope_key, title: t.title }
    }
  } catch { /* no bookmark to read: start today's */ }
  return todaysHome()
}

interface LemApi {
  /** open on a scope and send this message */
  ask: (seed: string, scope?: Partial<ChatScope>) => void
  /** send this in a scope WITHOUT opening the chat: the work shows up where it was
   *  asked for (a draft appearing in the item's pane), not as a conversation */
  write: (seed: string, scope?: Partial<ChatScope>) => void
  /** open on a scope without sending anything */
  show: (scope?: Partial<ChatScope>) => void
  collapse: () => void
  isOpen: boolean
  /** a `write` for this scope is still running */
  isWriting: (key: string) => boolean
}

const Ctx = createContext<LemApi>({ ask: () => {}, write: () => {}, show: () => {}, collapse: () => {}, isOpen: false, isWriting: () => false })
export const useLem = () => useContext(Ctx)

/* A message waiting to be sent belongs to one conversation and is sent once. It used to be
   one loose value that whichever conversation mounted next would send, so opening another
   conversation (Ask on a meeting, say) sent the last thing asked somewhere else again. */
type Seed = { text: string; n: number; key: string } | null
/** A `write` in flight: sent from out of sight, so the chat that is open stays as it was. */
interface Writing { n: number; text: string; scope: ChatScope }

/** "Do" is a piece of work, so it gets a row in `tasks` — what the pills read, and how the
 *  work is findable tomorrow. Lem closes the row when it finishes. Same write as before. */
async function asTask(text: string, scopeKey: string): Promise<string> {
  let seed = `Please do this: ${text}`
  try {
    const created = await records.create('tasks', {
      title: text.slice(0, 140), detail: text, status: 'working', source: 'manual',
      urgency: 2, opened_at: new Date().toISOString(),
      // which conversation the work is happening in, so the task can be opened again later
      thread_ref: `chat:${scopeKey}`,
    }) as { id?: string }
    if (created?.id) {
      seed = `Please do this: ${text}\n\n`
        + `(This is task ${created.id}. When you have finished, set that row's status to 'done' — `
        + `or 'dropped' if it turned out not to be needed — so it stops showing as running. `
        + `If the answer is a document, write the file and say in one line that it is ready.)`
    }
  } catch { /* the chat still works without the row */ }
  return seed
}

export function LemProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const [scope, setScopeState] = useState<ChatScope | null>(null)
  const [seed, setSeed] = useState<Seed>(null)
  const [writes, setWrites] = useState<Writing[]>([])
  const n = useRef(0)
  const sent = useRef(new Set<number>())
  const scopeRef = useRef<ChatScope | null>(null)
  const setScope = useCallback((s: ChatScope) => { scopeRef.current = s; setScopeState(s) }, [])
  /** true the first time a seed is asked for, never again */
  const takeSeed = useCallback((k: number) => { if (sent.current.has(k)) return false; sent.current.add(k); return true }, [])
  // the main conversation for now, and when the dock was last used (for a tab left open overnight)
  const main = useRef<ChatScope>(todaysHome())
  const touched = useRef(Date.now())
  useEffect(() => {
    const look = () => { if (!document.hidden) void currentHome().then((s) => { main.current = s }) }
    look()
    document.addEventListener('visibilitychange', look)
    return () => document.removeEventListener('visibilitychange', look)
  }, [])
  /** Carry on in whatever is open, unless that is a main conversation from an earlier day. */
  const carryOn = (cur: ChatScope | null): ChatScope => {
    const stale = !!cur && isHome(cur.key) && cur.key !== main.current.key
      && dayKey(new Date(touched.current)) !== dayKey() && Date.now() - touched.current > CARRY_ON_MS
    touched.current = Date.now()
    return !cur || stale ? main.current : cur
  }

  const ask = useCallback((text: string, s?: Partial<ChatScope>) => {
    // a named scope wins; otherwise carry on in whichever conversation was last open
    const to = s ? { ...HOME, ...s } : carryOn(scopeRef.current)
    setScope(to)
    setSeed({ text, n: ++n.current, key: to.key })
    setOpen(true)
  }, [])
  const write = useCallback((text: string, s?: Partial<ChatScope>) => {
    const to = s ? { ...HOME, ...s } : carryOn(scopeRef.current)
    // one at a time per conversation; the buttons that ask are off while it runs
    setWrites((w) => (w.some((x) => x.scope.key === to.key) ? w : [...w, { n: ++n.current, text, scope: to }]))
  }, [])
  const show = useCallback((s?: Partial<ChatScope>) => {
    setScope(s ? { ...HOME, ...s } : carryOn(scopeRef.current))
    setOpen(true)
  }, [])
  const collapse = useCallback(() => setOpen(false), [])
  const isWriting = useCallback((key: string) => writes.some((w) => w.scope.key === key), [writes])
  const written = useCallback((k: number) => setWrites((w) => w.filter((x) => x.n !== k)), [])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (isOpen) setOpen(false); else { setScope(carryOn(scopeRef.current)); setOpen(true) }
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [isOpen])

  return (
    <Ctx.Provider value={{ ask, write, show, collapse, isOpen, isWriting }}>
      <DockState.Provider value={{ scope, seed, takeSeed, setScope, isOpen, setOpen, home: () => main.current }}>
        {children}
        {writes.map((w) => <Writer key={w.n} w={w} onDone={written} />)}
      </DockState.Provider>
    </Ctx.Provider>
  )
}

interface Dock { scope: ChatScope | null; seed: Seed; takeSeed: (n: number) => boolean; setScope: (s: ChatScope) => void; isOpen: boolean; setOpen: (v: boolean) => void; home: () => ChatScope }
const DockState = createContext<Dock>({ scope: null, seed: null, takeSeed: () => false, setScope: () => {}, isOpen: false, setOpen: () => {}, home: todaysHome })

/* ---------------- work asked for from a pane ---------------- */

/** Sends one `write` in its own conversation, out of sight, and lets go when the run ends.
 *  The pane that asked shows it being written and re-reads the draft when it is done. */
function Writer({ w, onDone }: { w: Writing; onDone: (n: number) => void }) {
  const { bump } = useNav()
  // undefined: still looking for the conversation this scope already has
  const [convId, setConvId] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void rememberedConversation(w.scope.key).then((id) => { if (live) setConvId(id) })
    return () => { live = false }
  }, [w.scope.key])
  const instructions = useMemo(() => instructionsFor(w.scope.about), [w.scope.about])
  const thread = useConversationMessages({ client, agentName: 'pod_default', conversationId: convId ?? null, instructions, autoResume: false })
  const running = thread.isStreaming || thread.isRunning
  const began = useRef(false)
  const sawRun = useRef(false)
  const finish = useRef(false)
  const done = () => { if (finish.current) return; finish.current = true; bump(); onDone(w.n) }

  useEffect(() => {
    if (convId === undefined || began.current) return
    began.current = true
    void (async () => {
      try {
        let id = convId
        if (!id) {
          const c = await client.conversations.createForAgent('pod_default') as { id: string }
          id = c.id
          setConvId(id)
        }
        void remember(w.scope.key, id, w.scope.title)
        await thread.sendMessage(w.text, { conversationId: id })
      } catch (err) { console.error(`${tm()} could not take that`, err); done() }
    })()
  }, [convId])
  useEffect(() => {
    if (running) { sawRun.current = true; return }
    if (sawRun.current) done()
  }, [running])
  // never left spinning: a run that cannot be seen ending is let go after a few minutes
  useEffect(() => { const t = window.setTimeout(done, 6 * 60_000); return () => window.clearTimeout(t) }, [])
  return null
}

/* ---------------- context from Focus ---------------- */

function useFocusContext() {
  const { focus } = useNav()
  const f = focus as Focus | null
  const q = useSql<{ label: string }>(f
    ? f.type === 'person' ? `select name as label from people where id=${lit(f.id)}`
      : f.type === 'company' ? `select name as label from companies where id=${lit(f.id)}`
        : f.type === 'doc' ? `select title as label from deliverables where id=${lit(f.id)}`
          : f.type === 'workstream' ? `select title as label from work_projects where id=${lit(f.id)}`
            : f.type === 'meeting' ? `select subject as label from interactions where id=${lit(f.id)}`
              : `select obligation as label from loops where id=${lit(f.id)}`
    : null)
  if (!f) return null
  const label = q.items[0]?.label ?? ''
  const what = f.type === 'loop' ? `the commitment "${label}" (loop_id ${f.id})`
    : f.type === 'doc' ? `the document "${label}" (deliverables id ${f.id})`
      : f.type === 'workstream' ? `the workstream "${label}" (work_project_id ${f.id})`
        : f.type === 'meeting' ? `their meeting "${label}" (calendar row ${f.id} in interactions)`
          : `${label} (${f.type}_id ${f.id})`
  return { key: `${f.type}:${f.id}`, label, what }
}

/* ---------------- the dock ---------------- */

export type TaskRow = { id: string; title: string; status: string; thread_ref?: string | null; updated_at?: string | null }

/** Open the conversation a piece of asked-for work is happening in. */
export function useOpenTask() {
  const { show } = useLem()
  return useCallback(async (t: TaskRow) => {
    const key = (t.thread_ref ?? '').startsWith('chat:') ? t.thread_ref!.slice(5) : `task:${t.id}`
    let title = t.title
    try {
      const rows = await sql<{ title: string }>(`select title from chat_threads where scope_key=${lit(key)} limit 1`)
      title = rows[0]?.title || title
    } catch { /* the task's own title will do */ }
    show(key.startsWith('task:') ? { key, title, about: `a piece of work they asked for: "${t.title}"` } : scopeFor({ scope_key: key, title }))
  }, [show])
}

/** What is running, and what finished in the last day: each one opens its conversation. */
function Tasks() {
  const { version } = useNav()
  const openTask = useOpenTask()
  const q = useSql<TaskRow>(rev(
    `select id, title, status, thread_ref, updated_at from tasks
     where source='manual' and (status='working'
        or (status in ('drafted','done') and updated_at > now() - interval '1 day'))
     order by (status='working') desc, updated_at desc limit 3`, version))
  if (!q.items.length) return null
  return (
    <div className="taskpills">
      {q.items.map((t) => (
        <button key={t.id} className={`taskpill${t.status === 'working' ? '' : ' is-done'}`}
          title={t.status === 'working' ? `Working on: ${t.title}` : `Done: ${t.title}`} onClick={() => void openTask(t)}>
          {t.status === 'working' ? <Orb live size={10} /> : <Check size={12} strokeWidth={2.8} />} <span>{t.title}</span>
        </button>
      ))}
    </div>
  )
}

function ModeSwitch({ mode, setMode }: { mode: 'ask' | 'do'; setMode: (m: 'ask' | 'do') => void }) {
  return (
    <div className="mode" role="radiogroup" aria-label="Ask or do">
      <button role="radio" aria-checked={mode === 'ask'} className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>Ask</button>
      <button role="radio" aria-checked={mode === 'do'} className={mode === 'do' ? 'on' : ''} onClick={() => setMode('do')}>Do</button>
    </div>
  )
}

export function LemDock() {
  const dock = useContext(DockState)
  const { seed, takeSeed, setScope, isOpen, setOpen } = dock
  // opened before anything named a conversation: carry on in today's main one
  const scope = dock.scope ?? (isOpen ? dock.home() : null)
  const { ask } = useLem()
  const { version } = useNav()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'ask' | 'do'>('ask')
  const [running, setRunning] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [dropped, setDropped] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ctx = useFocusContext()
  const useCtx = !!ctx && !!ctx.label && dropped !== ctx.key && !(scope && scope.key === ctx.key)

  // "/" puts you in the bar from anywhere
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || t?.closest?.('input,textarea,[contenteditable]')) return
      e.preventDefault()
      if (isOpen) document.querySelector<HTMLTextAreaElement>('.lem .composer textarea')?.focus()
      else inputRef.current?.focus()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [isOpen])

  async function fire() {
    const v = text.trim()
    if (!v) return
    setText('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    if (mode !== 'do') { ask(v); return }
    // each piece of work gets a conversation of its own, so it can be found and reopened
    const key = `task:${Date.now()}`
    ask(await asTask(v, key), { key, title: v.slice(0, 60), about: `a piece of work they asked for: "${v.slice(0, 200)}"` })
  }

  const threads = useSql<{ scope_key: string; title: string; last_used_at: string }>(rev(listOpen
    ? `select c.scope_key,
            case when c.scope_key like 'loop:%' and l.obligation is not null then l.obligation
                 else coalesce(c.title,'') end as title,
            c.last_used_at
       from chat_threads c
       left join loops l on c.scope_key = 'loop:' || l.id::text
       order by c.last_used_at desc nulls last limit 30`
    : null, version))

  const baseAbout = scope?.about ?? HOME.about
  const live: ChatScope | null = scope && {
    ...scope,
    about: useCtx ? `${baseAbout}. Right now they have ${ctx!.what} open in their workspace — assume questions are about it unless they say otherwise.` : baseAbout,
  }
  const title = (scope?.title === 'Work this loop' ? 'A commitment' : scope?.title) || tm()

  return (
    <div className={`lem${isOpen ? ' open' : ''}`}>
      {!isOpen && <Tasks />}
      {isOpen && live && (
        <div className={`lem-sheet${listOpen ? ' listing' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}>
          <div className="lem-head">
            <Orb live={running} size={20} />
            <button className="lem-title" onClick={() => setListOpen((v) => !v)} title="Your conversations">
              <span>{listOpen ? 'Conversations' : title}</span>
              <ChevronDown size={13} style={{ transform: listOpen ? 'rotate(180deg)' : 'none' }} />
            </button>
            <span className="grow" />
            <button className="icon-btn" title="Conversations" onClick={() => setListOpen((v) => !v)}><History size={15} /></button>
            <button className="icon-btn" title="New conversation"
              onClick={() => { setListOpen(false); setScope({ ...HOME, key: `home:${Date.now()}`, title: 'New conversation' }) }}>
              <Plus size={16} />
            </button>
            <button className="icon-btn" title="Collapse (Esc)" onClick={() => setOpen(false)}><Minus size={16} /></button>
          </div>
          {listOpen ? (
            <div className="threads">
              {threads.items.length === 0 && <p className="muted" style={{ padding: 16 }}>No conversations yet.</p>}
              {threads.items.map((t) => (
                <button key={t.scope_key} className={`thread${t.scope_key === scope?.key ? ' on' : ''}`}
                  onClick={() => { setListOpen(false); setScope(scopeFor(t)) }}>
                  <span className="thread-t">{t.title === 'Work this loop' ? 'A commitment' : t.title || 'Conversation'}</span>
                  <span className="muted">{ageLabel(t.last_used_at)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {/* the conversation stays mounted once started, so collapsing never loses a running turn */}
      {live && (
        <div className="lem-chatwrap" hidden={!isOpen || listOpen}>
          {useCtx && (
            <div className="ctx">
              <span className="ctx-chip" title={`${tm()} reads this as the context for your question`}>
                <span className="ctx-k">About</span>
                {ctx!.label.length > 52 ? `${ctx!.label.slice(0, 52)}…` : ctx!.label}
                <button aria-label="Remove context" onClick={() => setDropped(ctx!.key)}><X size={11} /></button>
              </span>
            </div>
          )}
          <Chat key={live.key} scope={live} seed={seed?.key === live.key ? seed : null} takeSeed={takeSeed} onRunning={setRunning} active={isOpen} />
        </div>
      )}
      {!isOpen && (
        <div className="bar">
          <button className="bar-orb" title={`Open ${tm()} (⌘J)`} onClick={() => setOpen(true)}><Orb live={running} size={22} /></button>
          <textarea
            ref={inputRef} rows={1} value={text}
            placeholder={running ? `${tm()} is working. Ask something else, or open it to watch` : mode === 'ask' ? `Ask ${tm()} anything…` : `Tell ${tm()} what to do…`}
            onChange={(e) => {
              setText(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void fire() }
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
            }}
          />
          <ModeSwitch mode={mode} setMode={setMode} />
          <button className="go" disabled={!text.trim()} onClick={() => void fire()} title="Send"><ArrowUp size={15} strokeWidth={2.4} /></button>
        </div>
      )}
    </div>
  )
}

function scopeFor(t: { scope_key: string; title: string }): ChatScope {
  const k = t.scope_key
  if (k.startsWith('person:')) return { key: k, title: t.title, about: `${t.title.replace(/^About /, '')} (person_id ${k.slice(7)})` }
  if (k.startsWith('company:')) return { key: k, title: t.title, about: `${t.title.replace(/^About /, '')} (company_id ${k.slice(8)})` }
  if (k.startsWith('workstream:')) return { key: k, title: t.title, about: `the workstream "${t.title}" (work_project_id ${k.slice(11)})` }
  if (k.startsWith('loop:')) return { key: k, title: t.title, about: `the commitment "${t.title}" (loop_id ${k.slice(5)})` }
  if (k.startsWith('meeting:')) return { key: k, title: t.title, about: `their meeting "${t.title}" (calendar row ${k.slice(8)} in interactions)` }
  return { ...HOME, key: k, title: t.title || '' }
}

/* ---------------- talking about one document ---------------- */

/* Beside a document, sheet or deck in the viewer: its own conversation, kept like any other
   (scope `doc:<id>`), so what was asked and what the teammate changed stays readable. A
   passage selected on the page rides along as a quote; selecting another replaces it. */
export function DocChat({ id, title, what, quote, onClearQuote, starters }: {
  id: string; title: string; what: string
  quote: string | null; onClearQuote: () => void; starters: string[]
}) {
  const scope = useMemo<ChatScope>(() => ({ key: `doc:${id}`, title, about: `the ${what} "${title}" (deliverable ${id})` }), [id, title, what])
  const { bump } = useNav()
  const [convId, setConvId] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let live = true
    setBooting(true); setConvId(null)
    rememberedConversation(scope.key)
      .then((c) => { if (live) { setConvId(c); setBooting(false) } })
      .catch(() => { if (live) setBooting(false) })
    return () => { live = false }
  }, [scope.key])
  useEffect(() => { if (quote) inputRef.current?.focus() }, [quote])

  const instructions = useMemo(() => instructionsFor(scope.about), [scope.about])
  const thread = useConversationMessages({ client, agentName: 'pod_default', conversationId: convId, instructions, autoResume: true })
  const running = thread.isStreaming || thread.isRunning
  // when a change lands, the page beside it shows the new version
  const was = useRef(false)
  useEffect(() => { if (running) { was.current = true; return } if (was.current) { was.current = false; bump() } }, [running])
  useEffect(() => {
    const t = window.setInterval(() => { if (running) bump() }, 5000)
    return () => window.clearInterval(t)
  }, [running])

  const turns = toTurns(thread.messages as Msg[])
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [turns.length, thread.streamingText, turns[turns.length - 1]?.steps.length])

  async function send(text = draft.trim()) {
    if (!text || running) return
    setDraft('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    const part = quote ? `, the part that says "${quote.replace(/"/g, "'")}"` : ''
    onClearQuote()
    const msg = `About the ${what} "${title}" (deliverable ${id})${part}: ${text}\n\n`
      + `If this asks for a change, update that deliverables row in place, keep everything else as it is, and say in one line what you changed.`
    try {
      let c = convId
      if (!c) { const made = await client.conversations.createForAgent('pod_default') as { id: string }; c = made.id; setConvId(c) }
      void remember(scope.key, c, title)
      await thread.sendMessage(msg, { conversationId: c })
    } catch (err) { console.error(`${tm()} could not take that`, err) }
  }

  return (
    <div className="dchat">
      <div className="dchat-log" ref={logRef}>
        {!booting && turns.length === 0 && !running && (
          <div className="dchat-empty">
            <p>Ask about any part, or say what should change. {tm()} edits the {what} in place.</p>
            <div className="dchat-starters">
              {starters.map((s) => (
                <button key={s} className="dchat-starter" onClick={() => void send(s)}>
                  <span>{s}</span><ArrowUp size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => {
          const live = i === turns.length - 1 && running
          return (
            <Fragment key={i}>
              {t.user && <div className="said me"><div className="bubble">{t.user}</div></div>}
              <div className="said lem-said">
                {live && !thread.streamingText && <div className="step"><Orb live size={13} /> {(t.steps[t.steps.length - 1] ?? 'Working on it')}…</div>}
                {t.replies.map((r, j) => <div key={j} className="lem-text"><Reply text={r} /></div>)}
                {live && thread.streamingText && <div className="lem-text"><Reply text={thread.streamingText} /></div>}
              </div>
            </Fragment>
          )
        })}
        {running && turns.length === 0 && <div className="said lem-said"><div className="step"><Orb live size={13} /> Working on it…</div></div>}
        {thread.error && !running && <div className="chat-err">{tm()} stopped before finishing. Ask again, or put it differently.</div>}
      </div>
      <div className="dchat-box">
        {quote && (
          <div className="dchat-quote">
            <span className="dchat-quote-t">{quote}</span>
            <button className="icon-btn" aria-label="Don’t ask about this part" onClick={onClearQuote}><X size={13} /></button>
          </div>
        )}
        <div className="dchat-row">
          <textarea ref={inputRef} rows={1} value={draft}
            placeholder={running ? `${tm()} is on it…` : quote ? 'What about this part?' : `Ask ${tm()} about the ${what}…`}
            onChange={(e) => {
              setDraft(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
          {running
            ? <button className="go stop" onClick={() => void thread.stop(convId)} title="Stop"><Square size={10} fill="currentColor" /></button>
            : <button className="go" disabled={!draft.trim()} onClick={() => void send()} title="Send"><ArrowUp size={15} strokeWidth={2.4} /></button>}
        </div>
      </div>
    </div>
  )
}

/* ---------------- the conversation ---------------- */

type Msg = {
  id?: string; role?: string; kind?: string; text?: string; content?: string
  tool_name?: string; tool_args?: Record<string, unknown> | null; created_at?: string
}

function textOf(m: Msg): string | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null
  const kind = (m.kind ?? 'text').toLowerCase()
  if (kind !== 'text' && kind !== 'message') return null
  const t = (typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : '').trim()
  return t || null
}

/** Lem's tool calls, sorted into a handful of plain phrases (never the engineer's comment). */
function stepLabel(m: Msg): string | null {
  if ((m.kind ?? '').toUpperCase() !== 'TOOL_CALL') return null
  const name = (m.tool_name ?? '').toLowerCase()
  const a = (m.tool_args ?? {}) as Record<string, unknown>
  const blob = `${name} ${String(a.sql ?? '')} ${String(a.path ?? '')} ${String(a.cmd ?? '')}`.toLowerCase()
  if (/load_skill|list_skills|agents\.md/.test(blob)) return null
  if (/insert into drafts|drafts.*(create|update)|deliverables.*(create|insert)|voice\.md/.test(blob)) return 'Writing it'
  if (/granola|meeting/.test(blob)) return 'Reading your meeting notes'
  if (/calendar|free_slots|slot/.test(blob)) return 'Checking your calendar'
  if (/gmail|interactions|\/people\/|thread/.test(blob)) return 'Reading your mail'
  if (/search|web|research/.test(blob)) return 'Looking it up'
  return 'Working on it'
}

/* What a pane's buttons send is written for the teammate, not to be read back. In the
   conversation it shows as the one line the person actually asked for. */
function asSaid(t: string): string {
  const doc = t.match(/^About the [^"]+ "[\s\S]*?" \(deliverable [^)]+\)(?:, the part that says "([\s\S]*?)")?: ([\s\S]*?)\n\nIf this asks for a change/)
  if (doc) return doc[1] ? `On “${doc[1].length > 80 ? `${doc[1].slice(0, 80)}…` : doc[1]}”: ${doc[2]}` : doc[2]
  const said = t.match(/ My direction: "([\s\S]*)"\. End with the card marker\.$/)?.[1]
  const tail = said ? `: “${said}”` : ''
  let m = t.match(/^Write a short nudge to (.+?) about "[\s\S]*End with the card marker\.$/)
  if (m) return `Write the nudge to ${m[1].split(' ')[0]}${tail}`
  m = t.match(/^Prepare "(.+?)" for me \(commitment [\s\S]*End with the card marker\.$/)
  if (m) return `Prepare “${m[1]}”${tail}`
  m = t.match(/^Write the short brief for my meeting "(.+?)" on [\s\S]*Run first_meetings/)
  if (m) return `Write the brief for “${m[1]}”`
  return t
}

interface Turn { user?: string; steps: string[]; replies: string[] }

function toTurns(msgs: Msg[]): Turn[] {
  const out: Turn[] = []
  let cur: Turn | null = null
  for (const m of msgs) {
    const t = textOf(m)
    if (m.role === 'user' && t) {
      cur = { user: asSaid(t.replace(/\n\n\(This is task [\s\S]*$/, '').replace(/^Please do this: /, '')), steps: [], replies: [] }
      out.push(cur)
      continue
    }
    if (!cur) { cur = { steps: [], replies: [] }; out.push(cur) }
    const s = stepLabel(m)
    if (s && cur.steps[cur.steps.length - 1] !== s) cur.steps.push(s)
    if (m.role === 'assistant' && t) cur.replies.push(t)
  }
  return out
}

function Reply({ text }: { text: string }) {
  const parts = useMemo(() => {
    const re = /\[\[(draft|doc):([0-9a-f-]{36})\]\]/gi
    const out: ({ t: string } | { kind: 'draft' | 'doc'; id: string })[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index) })
      out.push({ kind: m[1].toLowerCase() as 'draft' | 'doc', id: m[2] })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ t: text.slice(last) })
    return out
  }, [text])
  return (
    <>
      {parts.map((p, i) => ('t' in p
        ? (p.t.trim() ? <Markdown key={i} text={p.t} /> : null)
        : <div key={i} className="chat-chip"><WorkChip kind={p.kind} id={p.id} /></div>))}
    </>
  )
}

async function rememberedConversation(scopeKey: string): Promise<string | null> {
  try {
    const rows = await sql<{ conversation_id: string }>(
      `select conversation_id from chat_threads where scope_key=${lit(scopeKey)}
       order by last_used_at desc limit 1`)
    return rows[0]?.conversation_id ?? null
  } catch { return null }
}

async function remember(scopeKey: string, conversationId: string, title: string) {
  try {
    const rows = await sql<{ id: string }>(`select id from chat_threads where scope_key=${lit(scopeKey)} limit 1`)
    const patch = { conversation_id: conversationId, title, last_used_at: new Date().toISOString() }
    if (rows[0]) await records.update('chat_threads', rows[0].id, patch)
    else await records.create('chat_threads', { scope_key: scopeKey, ...patch })
  } catch { /* the conversation still works without the bookmark */ }
}

const STARTERS = [
  'What needs me today?',
  'Prepare everything I owe people this week',
  'What did I promise on my last call?',
]

const instructionsFor = (about: string) =>
  `You are ${tm()}, talking to the person inside their desk app, which shows cards.\nCONTEXT: ${about}\n`
  + `Answer in one or two sentences unless they ask for more; at most four short bullets. `
  + `Never mention workflows, schedules, functions, tables or ids. `
  + `When you prepare an email, meeting or document, end with its [[draft:id]] or [[doc:id]] marker — never paste it.`

function Chat({ scope, seed, takeSeed, onRunning, active }: {
  scope: ChatScope; seed: Seed; takeSeed: (n: number) => boolean; onRunning: (v: boolean) => void; active: boolean
}) {
  const [convId, setConvId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'ask' | 'do'>('ask')
  const [booting, setBooting] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let live = true
    setBooting(true); setConvId(null)
    rememberedConversation(scope.key)
      .then((id) => { if (live) { setConvId(id); setBooting(false) } })
      .catch(() => { if (live) setBooting(false) })
    return () => { live = false }
  }, [scope.key])

  useEffect(() => { if (!booting && active) inputRef.current?.focus() }, [booting, active, scope.key])

  const instructions = useMemo(() => instructionsFor(scope.about), [scope.about])

  const thread = useConversationMessages({
    client, agentName: 'pod_default', conversationId: convId,
    instructions, autoResume: true,
  })
  const running = thread.isStreaming || thread.isRunning
  useEffect(() => { onRunning(running) }, [running, onRunning])

  /* A task must not spin for ever because nobody closed its row. When the run in this
     conversation ends, anything still marked as running here becomes "ready to look at"
     (the teammate marks it done itself when it knows the work is finished). */
  const { bump } = useNav()
  const wasRunning = useRef(false)
  useEffect(() => {
    if (running) { wasRunning.current = true; return }
    if (!wasRunning.current) return
    wasRunning.current = false
    void (async () => {
      try {
        const rows = await sql<{ id: string }>(
          `select id from tasks where status='working' and thread_ref=${lit(`chat:${scope.key}`)}`)
        for (const r of rows) await records.update('tasks', r.id, { status: 'drafted' })
      } catch { /* the pill clears on the next run instead */ }
      bump()
    })()
  }, [running, scope.key])

  useEffect(() => {
    if (!seed || booting || seed.key !== scope.key || !takeSeed(seed.n)) return
    void (async () => {
      try {
        const id = await ensureConversation(seed.text)
        await thread.sendMessage(seed.text, { conversationId: id })
      } catch (err) { console.error('Lem could not take that message', err) }
    })()
  }, [seed, booting])

  const turns = toTurns(thread.messages as Msg[])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, thread.streamingText, turns[turns.length - 1]?.steps.length, active])

  /** The hook will not open a conversation for us; do it here and hand the id straight on. */
  async function ensureConversation(firstText: string): Promise<string> {
    if (convId) { void remember(scope.key, convId, scope.title); return convId }
    const c = await client.conversations.createForAgent('pod_default') as { id: string }
    setConvId(c.id)
    const title = isHome(scope.key) ? firstText.replace(/^Please do this: /, '').replace(/\n[\s\S]*$/, '').slice(0, 60) : scope.title
    void remember(scope.key, c.id, title)
    return c.id
  }

  async function send(text = draft.trim()) {
    if (!text || running) return
    setDraft('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    const msg = mode === 'do' ? await asTask(text, scope.key) : text
    try {
      const id = await ensureConversation(msg)
      await thread.sendMessage(msg, { conversationId: id })
    } catch (err) { console.error('Lem could not take that message', err) }
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {thread.hasOlderMessages && (
          <button className="link-q center" disabled={thread.isLoadingOlder} onClick={() => void thread.loadOlder()}>
            {thread.isLoadingOlder ? 'Loading…' : 'Earlier messages'}
          </button>
        )}
        {!booting && turns.length === 0 && !running && (
          <div className="chat-empty">
            <Orb size={40} />
            <div className="chat-empty-h">What can I take off your plate?</div>
            <div className="starters">
              {STARTERS.map((s) => <button key={s} className="starter" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {turns.map((t, i) => {
          const last = i === turns.length - 1
          const live = last && running
          return (
            <Fragment key={i}>
              {t.user && <div className="said me"><div className="bubble">{t.user}</div></div>}
              <div className="said lem-said">
                {live && !thread.streamingText && (
                  <div className="step"><Orb live size={14} /> {(t.steps[t.steps.length - 1] ?? 'Working on it')}…</div>
                )}
                {t.replies.map((r, j) => <div key={j} className="lem-text"><Reply text={r} /></div>)}
                {live && thread.streamingText && <div className="lem-text"><Reply text={thread.streamingText} /></div>}
              </div>
            </Fragment>
          )
        })}
        {running && turns.length === 0 && <div className="said lem-said"><div className="step"><Orb live size={14} /> Working on it…</div></div>}
        {thread.error && !running && <div className="chat-err">{tm()} stopped before finishing. Send it again, or ask it differently.</div>}
      </div>
      <div className="composer">
        <textarea
          ref={inputRef} value={draft} rows={1}
          placeholder={running ? `${tm()} is working. You can collapse this, it keeps going` : `Reply to ${tm()}…`}
          onChange={(e) => {
            setDraft(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
        />
        <ModeSwitch mode={mode} setMode={setMode} />
        {running ? (
          <button className="go stop" onClick={() => void thread.stop(convId)} title="Stop"><Square size={10} fill="currentColor" /></button>
        ) : (
          <button className="go" disabled={!draft.trim()} onClick={() => void send()} title="Send"><ArrowUp size={15} strokeWidth={2.4} /></button>
        )}
      </div>
    </div>
  )
}
