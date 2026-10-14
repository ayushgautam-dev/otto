import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Check, Mail, Plus, RefreshCw } from 'lucide-react'
import { runFn } from './lib'
import { useToast } from './ui'
import { SourceMark } from './brand'
import { tm } from './teammate'
import { useAccounts, accountLabel, type Provider } from './accounts'
import { SOURCES, OUTPUTS, SUGGESTED, orgId, readStatus, signInUrl, type App, type Status } from './connect'
import { readReach, startTelegram, readTelegramSetup, telegramReady, telegramFailed, telegramLink, lemmaPodUrl, type Reach, type TelegramSetup } from './reach'
import { setUpWhatsApp, whatsAppLink, whatsAppWebLink, firstMessage, qrPath, lastFour } from './whatsapp'

/* You: every way to reach the assistant, your mailboxes (which one new mail and the morning
   brief go out from, and a way to add another), and every app it works with. Opened from
   your name at the foot of the rail. The same parts as the desk's panel; the app list and
   the channels come from the shared connect.ts and reach.ts. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function Mailboxes({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const accounts = useAccounts()
  const [busy, setBusy] = useState<string | null>(null)
  const [org, setOrg] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, Status> | null>(null)

  const load = useCallback(async (o = org) => {
    if (!o) return
    try { setStatus(await readStatus(o)) } catch { setStatus({}) }
  }, [org])
  useEffect(() => { void orgId().then((o) => { setOrg(o); if (o) void load(o); else setStatus({}) }) }, [])
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])

  /** Connect a mailbox: the first of its kind, or one more beside it. */
  async function add(kind: Provider) {
    if (busy) return
    setBusy(`add:${kind}`)
    const had = accounts.mail.length
    // opened on the click itself; a tab opened after waiting on the pod is blocked
    const tab = window.open('', '_blank')
    try {
      const out = await runFn<{ auth_url?: string; authorization_url?: string; explanation?: string }>(
        'connect_source', { app: kind, add_another: accounts.mail.some((a) => a.provider === kind) })
      const url = out.auth_url || out.authorization_url
      if (!url) { tab?.close(); toast(out.explanation || 'That could not be started'); return }
      if (tab && !tab.closed) { tab.opener = null; tab.location.href = url }
      else { toast('Your browser blocked the sign-in tab. Allow pop-ups and try again'); return }
      for (let i = 0; i < 90; i++) {
        await sleep(2000)
        const now = await runFn<{ sources?: { app: string; accounts?: unknown[] }[] }>('sources_status', {})
        const n = (now.sources ?? []).filter((s) => s.app === 'gmail' || s.app === 'outlook')
          .reduce((t, s) => t + (s.accounts?.length ?? 0), 0)
        if (n > had) { await accounts.refresh(); toast('Mailbox added. Its last three weeks are loading'); return }
      }
      toast('Still waiting on that one. Try again once you have signed in')
    } catch (e) {
      tab?.close()
      toast(`Could not start that: ${(e as Error)?.message ?? 'try again'}`)
    } finally {
      setBusy(null)
    }
  }

  /** Any other app: the provider's own sign-in, then watch for the account to appear. */
  async function connect(app: App) {
    if (!org || busy) return
    setBusy(app.id)
    const tab = window.open('', '_blank')
    try {
      const out = await signInUrl(app, org)
      if (out.already) { tab?.close(); await load(); return }
      if (!out.url) { tab?.close(); toast(out.explanation || `${app.label} can’t be connected from here yet`); return }
      if (tab && !tab.closed) { tab.opener = null; tab.location.href = out.url }
      else { toast('Your browser blocked the sign-in tab. Allow pop-ups and try again'); return }
      for (let i = 0; i < 90; i++) {
        await sleep(2000)
        try {
          const s = await readStatus(org)
          setStatus(s)
          if (s[app.id] === 'connected') {
            toast(app.id === 'granola' ? `${app.label} connected. Your last few weeks of notes are loading` : `${app.label} connected`)
            await accounts.refresh()
            return
          }
        } catch { /* keep waiting */ }
      }
      toast('Still waiting on that one. Press refresh once you’ve signed in')
    } catch (e) {
      tab?.close()
      toast(`Could not start that: ${(e as Error)?.message ?? 'try again'}`)
    } finally {
      setBusy(null)
    }
  }

  const on = (a: App) => status?.[a.id] === 'connected'
  const sections: { title: string; apps: App[] }[] = [
    { title: `${tm()} reads from`, apps: SOURCES },
    { title: `${tm()} writes into`, apps: OUTPUTS },
    { title: 'Worth adding', apps: SUGGESTED },
  ]

  return (
    <>
      <div className="mbx-scrim" onClick={onClose} />
      <div className="mbx you-panel" role="dialog" aria-label="You">
        <div className="mbx-h">
          <b>You</b>
          <span className="btn-row">
            <button className="btn quiet" onClick={() => void load()} aria-label="Refresh"><RefreshCw size={14} /></button>
            <button className="btn quiet" onClick={onClose} aria-label="Close"><X size={15} /></button>
          </span>
        </div>

        <ReachSection />

        <div className="mbx-sec">Your mailboxes</div>
        {accounts.mail.length === 0 && <p className="mbx-none">No mailbox connected yet.</p>}
        {accounts.mail.map((a) => (
          <div key={a.id} className="mbx-row">
            <SourceMark app={a.provider} />
            <div className="mbx-t">
              <b>{accountLabel(a)}</b>
              <small>{a.provider === 'gmail' ? 'Gmail' : 'Outlook'}</small>
            </div>
            {accounts.multi && (accounts.primary?.id === a.id
              ? <span className="mbx-primary" title="New mail and your morning brief go out from here">Primary</span>
              : <button className="btn" onClick={() => void accounts.setPrimary(a)}>Make primary</button>)}
          </div>
        ))}
        <div className="mbx-add">
          <button className="btn" disabled={!!busy} onClick={() => void add('gmail')}>{busy === 'add:gmail' ? 'Waiting for sign-in…' : 'Add a Gmail'}</button>
          <button className="btn" disabled={!!busy} onClick={() => void add('outlook')}>{busy === 'add:outlook' ? 'Waiting for sign-in…' : 'Add an Outlook'}</button>
        </div>

        {status !== null && sections.map((sec) => {
          // connected first, then what still needs doing
          const apps = [...sec.apps].sort((a, b) => Number(on(b)) - Number(on(a)))
          return (
            <div key={sec.title}>
              <div className="mbx-sec">{sec.title}</div>
              {apps.map((a) => (
                <div key={a.id} className="mbx-row">
                  <SourceMark app={a.id} label={a.label} />
                  <div className="mbx-t">
                    <b>{a.label}</b>
                    <small className="why">{a.why}</small>
                  </div>
                  {status[a.id] === 'connected'
                    ? <span className="mbx-primary"><Check size={12} strokeWidth={2.6} /> Connected</span>
                    : <button className="btn" disabled={!!busy} onClick={() => void connect(a)}>
                        {busy === a.id ? 'Waiting for sign-in…' : status[a.id] === 'reauth' ? 'Sign in again' : 'Connect'}
                      </button>}
                </div>
              ))}
              {sec.apps === SUGGESTED && (
                <div className="mbx-row">
                  <span className="mark"><Plus size={16} /></span>
                  <div className="mbx-t">
                    <b>Any other app</b>
                    <small className="why">Ask {tm()} in Lemma to connect it: your CRM, a notes app, a project tracker.</small>
                  </div>
                  <a className="btn" href={lemmaPodUrl()} target="_blank" rel="noreferrer">Open Lemma</a>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ---------------- reach the assistant ---------------- */

function Qr({ text, label }: { text: string; label: string }) {
  const q = useMemo(() => qrPath(text), [text])
  return (
    <svg className="reach-qr" viewBox={`0 0 ${q.size} ${q.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={q.size} height={q.size} fill="#fff" />
      <path d={q.d} fill="#111" />
    </svg>
  )
}

/* Email, WhatsApp and Telegram: the assistant answers on all three, as itself, with
   everything it knows. Each row says where to write and sets the channel up if it isn't. */
function ReachSection() {
  const toast = useToast()
  const [r, setR] = useState<Reach | null>(null)
  const [qr, setQr] = useState(false)
  const [busy, setBusy] = useState<'whatsapp' | 'telegram' | null>(null)
  const [setup, setSetup] = useState<TelegramSetup | null>(null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void readReach().then((x) => { if (alive.current) setR(x) }).catch(() => null)
    return () => { alive.current = false }
  }, [])
  if (!r) return null
  const wa = r.whatsapp
  const hello = firstMessage(tm())

  async function copy() {
    if (!r?.email) return
    try { await navigator.clipboard.writeText(r.email); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { toast(r.email) }
  }
  async function whatsapp() {
    if (busy) return
    setBusy('whatsapp')
    try {
      const out = await setUpWhatsApp()
      setR((x) => (x ? { ...x, whatsapp: out } : x))
      if (out.handle) setQr(true)
      else toast('WhatsApp isn’t available in this workspace yet')
    } catch { toast('WhatsApp couldn’t be set up just now') } finally { setBusy(null) }
  }
  /** Opens Lemma's setup bot in Telegram, on the click itself (a tab opened later is
   *  blocked), then waits for the person to name their bot there. */
  async function telegram() {
    if (busy) return
    setBusy('telegram')
    const tab = window.open('', '_blank')
    try {
      const s = await startTelegram()
      setSetup(s)
      if (tab && !tab.closed) { tab.opener = null; tab.location.href = s.launch_url } else tab?.close()
      // naming a bot takes a minute or two; the setup itself runs out in about an hour
      for (let i = 0; i < 400 && alive.current; i++) {
        await sleep(3000)
        const now = await readTelegramSetup(s.setup_id).catch(() => null)
        if (!now) continue
        if (telegramReady(now)) {
          const handle = now.bot_username!.replace(/^@/, '')
          setR((x) => (x ? { ...x, telegram: { handle: `@${handle}`, link: now.bot_launch_url || telegramLink(handle) } } : x))
          toast(`Your Telegram bot is ready: @${handle}`)
          return
        }
        if (telegramFailed(now)) { toast(now.error || 'That setup ran out. Start it again'); return }
      }
    } catch (e) {
      tab?.close()
      toast(`Telegram couldn’t be set up: ${(e as Error)?.message ?? 'try again'}`)
    } finally {
      if (alive.current) { setSetup(null); setBusy(null) }
    }
  }

  const showWa = wa.offered || !!wa.handle
  if (!r.email && !showWa && !r.telegramOffered) return null
  return (
    <>
      <div className="mbx-sec first">Reach {tm()}</div>
      {r.email && (
        <div className="mbx-row">
          <span className="mark"><Mail size={16} /></span>
          <div className="mbx-t">
            <b>{r.email}</b>
            <small className="why">Write or forward anything. Your morning brief comes from here, and a reply to it reaches {tm()}.</small>
          </div>
          <button className="btn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {showWa && (
        <div className="mbx-row">
          <SourceMark app="whatsapp" label="WhatsApp" />
          <div className="mbx-t">
            <b>WhatsApp{wa.handle ? ` · ${wa.handle}` : ''}</b>
            <small className="why">{!wa.handle
              ? `Message ${tm()} from your phone.`
              : wa.mine
                ? `Write from your number ending ${lastFour(wa.mine)}; it is already linked.`
                : 'The first time, it asks for your email and sends a code there.'}</small>
          </div>
          {wa.handle ? (
            <span className="btn-row">
              <button className="btn" onClick={() => setQr(!qr)}>{qr ? 'Hide code' : 'Code'}</button>
              <a className="btn" href={whatsAppWebLink(wa.handle, hello)} target="_blank" rel="noreferrer">Open</a>
            </span>
          ) : (
            <button className="btn" disabled={!!busy} onClick={() => void whatsapp()}>{busy === 'whatsapp' ? 'Setting up…' : 'Set up'}</button>
          )}
        </div>
      )}
      {qr && wa.handle && (
        <div className="reach-qr-row">
          <Qr text={whatsAppLink(wa.handle, hello)} label={`QR code that opens a WhatsApp chat with ${wa.handle}`} />
          <small>Scan with your phone’s camera. The message is ready to send.</small>
        </div>
      )}
      {(r.telegram || r.telegramOffered) && (
        <div className="mbx-row">
          <SourceMark app="telegram" label="Telegram" />
          <div className="mbx-t">
            <b>Telegram{r.telegram?.handle ? ` · ${r.telegram.handle}` : ''}</b>
            <small className="why">{r.telegram
              ? `Your own bot for ${tm()}. Message it like a person.`
              : setup
                ? 'Name your bot in Telegram. This updates by itself when it’s made.'
                : `A bot of your own for ${tm()}, made inside Telegram in a minute.`}</small>
          </div>
          {r.telegram?.link
            ? <a className="btn" href={r.telegram.link} target="_blank" rel="noreferrer">Open</a>
            : !r.telegram && <button className="btn" disabled={!!busy} onClick={() => void telegram()}>{busy === 'telegram' ? 'Waiting for Telegram…' : 'Set up'}</button>}
        </div>
      )}
      {setup && (
        <div className="reach-qr-row">
          <Qr text={setup.launch_url} label="QR code that opens the Telegram setup on your phone" />
          <span className="reach-qr-side">
            <small>On your phone? Scan this to make the bot there instead.</small>
            <a className="link-q" href={setup.launch_url} target="_blank" rel="noreferrer">Open in Telegram</a>
          </span>
        </div>
      )}
    </>
  )
}
