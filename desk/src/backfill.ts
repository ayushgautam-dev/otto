import { createContext, useContext, useEffect, useState } from 'react'
import { client, runFn, records, sql, lit } from './lib'
import { setCatchUpSchedule } from './autopilot-sync'

/* Getting somebody's history in, without making them watch.

   First run used to load three weeks in one go and hold the person on a progress screen
   until every message had been read, which could be half an hour. Now it is two parts:

   - quickStart: the last week is collected and the desk opens.
   - catch-up, in the pod, not in this tab: the two older weeks are collected straight
     away, side by side, and only then does reading start. Reading hands one reader
     everything about one company, so a company's story is read whole and never from half
     its mail. Up to three readers work side by side on different companies, the small
     ones first so the desk starts filling early. When everything is read the person is
     told so; one closing check then goes over what was found against the whole history
     and closes what was already dealt with. Where it has got to lives in `settings` under `catchup`, so it carries on
     with the app closed. The Shell only watches (useCatchUp), keeps the readers topped
     up, and switches the timer off at the end.

   Mail is pulled in small slices because one function call that fetches a whole inbox
   outlives the 30 second request limit ("Mail: Request timed out after 30000ms"). */

export const WINDOW_DAYS = 21
const SLICE_DAYS = 4
const SLICE_MAX = 60

export interface CatchUp {
  /** how many days back have been loaded */
  covered: number
  target: number
  sources: string[]
  /** calendar and meeting notes are loaded whole, once */
  extras: boolean
  /** every week is collected; reading only starts after this */
  loaded?: boolean
  started_at?: string
  /** the closing check has run (only pods on the newer first run have this) */
  reconciled?: boolean
  /** the first slice has been grouped into what the person is working on (kept beside
   *  the state, in its own setting, because the pod rewrites the state itself) */
  grouped?: boolean
  done: boolean
  /** messages loaded but not read yet, for whoever is showing progress */
  unread?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function getSetting(key: string): Promise<{ id: string; value: string } | null> {
  try {
    const rows = await sql<{ id: string; value: string }>(
      `select id, value from settings where key=${lit(key)} limit 1`)
    return rows[0] ?? null
  } catch { return null }
}

export async function putSetting(key: string, value: string): Promise<void> {
  try {
    const row = await getSetting(key)
    if (row) await records.update('settings', row.id, { value })
    else await records.create('settings', { key, value })
  } catch { /* a setting that did not save is retried by whoever needs it next */ }
}

/** Interactions nothing has read yet: the honest measure of "still working". */
export async function unreadCount(): Promise<number> {
  try {
    const rows = await sql<{ n: number }>(`select count(*) as n from interactions where extracted_at is null`)
    return Number(rows[0]?.n ?? 0) || 0
  } catch { return 0 }
}

/* While an import runs, the pod-wide trigger must not also fire once per new mail row.
   The person gets a private flag; `backfill_guard` reads it and stands their triggered
   runs down. It expires on its own, so a closed tab never leaves mail unread for long. */
export const holdTrigger = (minutes: number) =>
  putSetting('backfill_until', new Date(minutes > 0 ? Date.now() + minutes * 60000 : 0).toISOString())

type Run = { id?: string; run_id?: string; status?: string }
const wf = () => client.workflows as unknown as {
  runs: {
    create: (n: string) => Promise<Run>
    get: (id: string) => Promise<Run>
    list: (n: string, o?: { limit?: number }) => Promise<{ items?: Run[] }>
  }
}
const OVER = ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING']

/** A run of this workflow that is still going, if there is one. Two readers on the same
 *  unread rows only get in each other's way, so nothing here starts a second. */
async function activeRun(name: string): Promise<string | null> {
  try {
    const out = await wf().runs.list(name, { limit: 40 })
    const r = (out.items ?? []).find((x) => (x.status || '').toUpperCase() === 'RUNNING')
    return r?.id || r?.run_id || null
  } catch { return null }
}

/** Start a workflow unless it is already running. Does not wait for it. */
export async function startWorkflow(name: string): Promise<string | null> {
  const going = await activeRun(name)
  if (going) return going
  const run = await wf().runs.create(name)
  return run.id || run.run_id || null
}

/** Wait for a run that is already going, without starting one. True when none is left. */
async function settle(name: string, budgetMs: number): Promise<boolean> {
  const id = await activeRun(name)
  if (!id) return true
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    await sleep(3000)
    try {
      if (OVER.includes(((await wf().runs.get(id)).status || '').toUpperCase())) return true
    } catch { return true }
  }
  return false
}

/** One more reader. Reading runs several at once: each reader is handed different people's
 *  mail, and the pod's gate turns away any beyond the number it allows, so asking for
 *  another is always safe. */
export async function startReader(): Promise<void> {
  await wf().runs.create('autopilot_loose_ends')
}

/** Run a workflow (or join the run already going) and wait for it, but never let a slow
 *  run hold the door shut. Returns whether it finished inside the budget. */
export async function runWorkflow(name: string, budgetMs = 90_000): Promise<boolean> {
  const id = await startWorkflow(name)
  if (!id) return true
  const until = Date.now() + budgetMs
  while (Date.now() < until) {
    await sleep(3000)
    try {
      if (OVER.includes(((await wf().runs.get(id)).status || '').toUpperCase())) return true
    } catch { return true }
  }
  return false
}

/** A request that timed out is still running on the other side, so it is not a failure;
 *  whatever it had not written yet is picked up by the next slice (duplicates are skipped). */
async function sync(name: string, input: Record<string, unknown>): Promise<{ recorded: number; seen: number }> {
  try {
    const out = await runFn<{ recorded?: number; skipped_duplicate?: number }>(name, input)
    const recorded = Number(out.recorded ?? 0) || 0
    return { recorded, seen: recorded + (Number(out.skipped_duplicate ?? 0) || 0) }
  } catch (e) {
    if (/timed out|timeout/i.test((e as Error)?.message ?? '')) return { recorded: 0, seen: 0 }
    throw e
  }
}

const MAIL_FILTER = '-in:spam -in:trash -category:promotions -category:social -category:forums'
const gmailDay = (daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * 86400000)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** Mail between `from` and `to` days ago (to > from). The edges overlap by a day on purpose. */
const mailSlice = (from: number, to: number) =>
  sync('sync_gmail', {
    query: from <= 0
      ? `newer_than:${to}d ${MAIL_FILTER}`
      : `after:${gmailDay(to + 1)} before:${gmailDay(from - 1)} ${MAIL_FILTER}`,
    max_messages: SLICE_MAX, batch_size: 10,
  })

export interface QuickResult { trouble: string[] }

/** The first minute: the most recent mail and this week's calendar. Reading them, and
 *  everything older, is handed to the pod so the desk can open straight away. */
export async function quickStart(sources: string[], say: (phase: string) => void): Promise<QuickResult> {
  const trouble: string[] = []
  const on = (app: string) => sources.includes(app)
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn() } catch (e) { trouble.push(`${label}: ${(e as Error)?.message ?? 'did not finish'}`) }
  }
  // One week here, so the desk can open on today's calendar within a couple of minutes.
  // The pod collects the two weeks before it straight afterwards, and reads once all
  // three are in.
  const covered = 7
  await holdTrigger(60)

  if (on('gmail')) {
    say('mail')
    await attempt('Mail', async () => {
      // in two pulls, so neither one outlives the request limit on a busy inbox
      await mailSlice(0, 3)
      await mailSlice(3, 7)
    })
  }
  if (on('google_calendar')) {
    say('calendar')
    await attempt('Calendar', () =>
      sync('sync_calendar', { past_days: covered, future_days: 14, max_events: 60, batch_size: 10 }))
  }

  if (on('outlook')) {
    // Microsoft 365: mail and calendar come through the one connection
    say('mail')
    await attempt('Mail', async () => {
      await sync('sync_outlook', { what: 'mail', days: 7, max_messages: 80, batch_size: 10 })
    })
    say('calendar')
    await attempt('Calendar', () =>
      sync('sync_outlook', { what: 'calendar', past_days: covered, future_days: 14, max_events: 60, batch_size: 10 }))
  }

  if (on('granola')) {
    // Meeting notes are where most promises are made, so the week's notes belong in the
    // first pass, not with the older weeks. Granola only offers whole calendar weeks, and
    // "this week" on a Monday is nearly empty, so last week comes along too.
    await attempt('Meeting notes', async () => {
      await sync('sync_granola', { time_range: 'this_week', batch_size: 10 })
      await sync('sync_granola', { time_range: 'last_week', batch_size: 10 })
    })
  }

  const unread = await unreadCount()
  const state: CatchUp = {
    covered, target: WINDOW_DAYS, sources, extras: false, loaded: false, done: false, unread,
    started_at: new Date().toISOString(),
  }
  await putSetting('catchup', JSON.stringify(state))
  await putSetting('catchup_grouped', '')
  await putSetting('catchup_wrapped', '')
  await putSetting('catchup_summary_seen', '')

  /* Hand over to the pod: this person's own timer, and one run now so reading starts
     without waiting for the first tick. A pod from before the catch-up workflow existed
     has neither, so there the plain reader is started and the nightly pass does the rest. */
  try {
    await setCatchUpSchedule(true)
    await startWorkflow('catch_up')
  } catch {
    if (unread) await attempt('Reading', () => startWorkflow('autopilot_loose_ends'))
  }
  return { trouble }
}

/** Load history again from today backwards, for a mailbox connected after first run.
 *  Everything already in the ledger is skipped, so only the new mailbox is read. */
export async function restartCatchUp(sources: string[]): Promise<void> {
  const state: CatchUp = {
    covered: 0, target: WINDOW_DAYS, sources, extras: false, loaded: false, done: false, unread: 0,
    started_at: new Date().toISOString(),
  }
  await putSetting('catchup', JSON.stringify(state))
  await putSetting('catchup_wrapped', '')
  // a mailbox added later is caught up quietly: no second "finished" summary
  await putSetting('catchup_summary_seen', '1')
  try {
    await setCatchUpSchedule(true)
    await startWorkflow('catch_up')
  } catch { /* the nightly pass picks the new mailbox up instead */ }
}

export async function readCatchUp(): Promise<CatchUp | null> {
  const row = await getSetting('catchup')
  if (!row) return null
  try {
    const s = JSON.parse(row.value) as CatchUp
    // the pod groups the first week itself; the app's own flag is the older fallback
    s.grouped = !!s.grouped || !!(await getSetting('catchup_grouped'))?.value
    return s
  } catch { return null }
}

/* One tab does the app's small share of the work. A second tab only watches. */
const LOCK = 'desk-catchup-beat'
const beat = () => { try { localStorage.setItem(LOCK, String(Date.now())) } catch { /* fine */ } }
const someoneElseIsOnIt = () => {
  try { return Date.now() - Number(localStorage.getItem(LOCK) || 0) < 45000 } catch { return false }
}

/** Watches the pod collect, read and check the history. `onProgress` refreshes the pages as
 *  rows land. The app's own part is small: keep the readers topped up, move the pod on to
 *  its next step without waiting for the timer, and at the very end learn how the person
 *  writes and stop the timer. */
export function useCatchUp(onProgress: () => void): CatchUp | null {
  const [state, setState] = useState<CatchUp | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      let last = ''
      let nudged = Date.now()
      let readerAsked = 0   // the first top-up is asked for the moment collecting ends
      // long enough for three weeks of slow reading; the pod carries on regardless
      for (let i = 0; live && i < 720; i++) {
        const s = await readCatchUp()
        if (!live || !s) return
        const wrapped = !!(await getSetting('catchup_wrapped'))?.value
        if (s.done && wrapped) { setState(null); return }
        setState(s)
        const unread = await unreadCount()
        const sig = `${s.covered}:${unread}:${s.loaded}:${s.done}`
        if (sig !== last) { last = sig; onProgress() }

        if (!someoneElseIsOnIt()) {
          beat()
          if (s.done) {
            await putSetting('catchup_wrapped', '1')
            await setCatchUpSchedule(false).catch(() => null)
            // every draft is only worth sending if it sounds like them; their sent mail is the sample
            await runWorkflow('autopilot_learn_voice', 180_000).catch(() => null)
            onProgress()
            if (live) setState(null)
            return
          }
          // once everything is collected, keep the readers topped up: the pod's gate
          // turns away any beyond the number it allows, so asking again is always safe
          if (s.loaded && unread > 0 && Date.now() - readerAsked > 45_000) {
            readerAsked = Date.now()
            await startReader().catch(() => null)
          }
          /* Move the pod on without waiting for the timer's next tick: collecting, then the
             closing check, then finishing. This joins a run that is already going, so
             asking again is safe. More often when nothing is left to read, because then
             the pod is the only thing that can take the next step. */
          if (Date.now() - nudged > (unread === 0 || !s.loaded ? 40_000 : 120_000)) {
            nudged = Date.now()
            // After collecting, a step is quick and safe to repeat, and it must not wait
            // behind an earlier run that has gone on to group topics or write replies.
            if (s.loaded) await wf().runs.create('catch_up').catch(() => null)
            else await startWorkflow('catch_up').catch(() => null)
          }
        }
        await sleep(15000)
      }
    })()
    return () => { live = false }
  }, [])
  return state && !state.done ? state : null
}

/** The four numbers shown while history is being read, and in the summary afterwards. */
export interface Progress { emails: number; people: number; found: number; replies: number; noise: number; dealt: number }

export async function readProgress(): Promise<Progress> {
  const z: Progress = { emails: 0, people: 0, found: 0, replies: 0, noise: 0, dealt: 0 }
  try {
    const r = (await sql<Record<keyof Progress, number>>(
      `select (select count(*) from interactions where kind='email') as emails,
              (select count(*) from people) as people,
              (select count(*) from loops) as found,
              (select count(*) from drafts) as replies,
              (select count(*) from interactions where triage='noise' or extractor_version in ('noise','prefilter')) as noise,
              (select count(*) from loops where close_reason like 'Already dealt with:%') as dealt`))[0]
    if (r) for (const k of Object.keys(z) as (keyof Progress)[]) z[k] = Number(r[k] ?? 0) || 0
  } catch { /* numbers are a courtesy; a failed count shows zeros */ }
  return z
}

export function useProgress(everyMs = 5000): Progress | null {
  const [p, setP] = useState<Progress | null>(null)
  useEffect(() => {
    let live = true
    const go = () => { void readProgress().then((x) => { if (live) setP(x) }) }
    go()
    const t = setInterval(go, everyMs)
    return () => { live = false; clearInterval(t) }
  }, [everyMs])
  return p
}

/** After first run has finished: what was done, shown once until the person dismisses it. */
export function useFinishedSummary(catching: CatchUp | null): { numbers: Progress; dismiss: () => void } | null {
  const [numbers, setNumbers] = useState<Progress | null>(null)
  useEffect(() => {
    if (catching) { setNumbers(null); return }
    let live = true
    void (async () => {
      const s = await readCatchUp()
      // (only a first run on this version records when it started)
      if (!s?.done || !s.started_at) return
      if ((await getSetting('catchup_summary_seen'))?.value) return
      const n = await readProgress()
      if (live) setNumbers(n)
    })()
    return () => { live = false }
  }, [catching])
  if (!numbers) return null
  return { numbers, dismiss: () => { setNumbers(null); void putSetting('catchup_summary_seen', '1') } }
}

/* Keep today's calendar honest while the app is open.
   A meeting made an hour ago should be on the day's timeline when the person looks, not
   tomorrow morning. A calendar watcher does this when it is on, but watchers can be off,
   paused or simply late, so the app also re-reads the calendars itself: when it opens,
   when the person comes back to the tab, and every so often in between. It is a small
   read (yesterday to a week ahead), and at most once every few minutes. */
const FRESH = 'desk-calendar-fresh'
const FRESH_EVERY = 5 * 60_000
const NOTES = 'desk-notes-fresh'
const NOTES_EVERY = 30 * 60_000

export function useFreshCalendar(sources: string[], onChange: () => void) {
  const key = sources.filter((s) => s === 'google_calendar' || s === 'outlook' || s === 'granola').sort().join(',')
  useEffect(() => {
    let live = true
    const run = async () => {
      try {
        if (Date.now() - Number(localStorage.getItem(FRESH) || 0) < FRESH_EVERY) return
        localStorage.setItem(FRESH, String(Date.now()))
      } catch { /* no storage: just read */ }
      const jobs: Promise<unknown>[] = []
      if (key.includes('google_calendar')) jobs.push(sync('sync_calendar', { past_days: 1, future_days: 7, max_events: 60, batch_size: 10 }))
      if (key.includes('outlook')) jobs.push(sync('sync_outlook', { what: 'calendar', past_days: 1, future_days: 7, max_events: 60, batch_size: 10 }))
      // Meeting notes too, less often: what was promised in this morning's call should
      // not wait for tonight. Nothing pushes them to us, so the app asks.
      if (key.includes('granola')) {
        let due = true
        try { due = Date.now() - Number(localStorage.getItem(NOTES) || 0) > NOTES_EVERY } catch { /* just ask */ }
        if (due) {
          try { localStorage.setItem(NOTES, String(Date.now())) } catch { /* fine */ }
          jobs.push(sync('sync_granola', { time_range: 'this_week', batch_size: 10 }))
        }
      }
      await Promise.allSettled(jobs)
      /* And never leave mail sitting unread. Watchers start a reading pass themselves,
         but if one was missed, this starts it (the pod lets only one run at a time).
         Not during the first-run catch-up, which reads its own rows. */
      try {
        const c = await readCatchUp()
        if ((!c || c.done) && (await unreadCount()) > 0) await startWorkflow('autopilot_loose_ends')
      } catch { /* the next watcher or the nightly pass reads them */ }
      if (live) onChange()
    }
    void run()
    const timer = setInterval(() => { if (!document.hidden) void run() }, FRESH_EVERY)
    const back = () => { if (!document.hidden) void run() }
    document.addEventListener('visibilitychange', back)
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', back) }
  }, [key])
}

/** Whether history is still loading, for pages that would otherwise say "nothing here". */
export const CatchUpCtx = createContext<CatchUp | null>(null)
export const useCatching = () => useContext(CatchUpCtx)
