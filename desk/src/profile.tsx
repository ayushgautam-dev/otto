import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Check, RefreshCw, Moon, SunMedium, Mail, Plus } from 'lucide-react'
import { runFn } from './lib'
import { Avatar, useToast } from './ui'
import { SourceMark } from './brand'
import { tm } from './teammate'
import { useAccounts, accountLabel, type Provider } from './accounts'
import { SOURCES, OUTPUTS, SUGGESTED, orgId, readStatus, signInUrl, type App, type Status } from './connect'
import { readReach, startTelegram, readTelegramSetup, telegramReady, telegramFailed, telegramLink, lemmaPodUrl, type Reach, type TelegramSetup } from './reach'
import { setUpWhatsApp, whatsAppLink, whatsAppWebLink, firstMessage, qrPath, lastFour } from './whatsapp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* You: who is signed in, every way to reach the assistant, and every app it works with.
   The app list and its status/connect logic live in connect.ts and the channels in reach.ts,
   both shared with the other app. */

function Row({ app, status, busy, onConnect }: { app: App; status: Status | undefined; busy: string | null; onConnect: (a: App) => void }) {
  const waiting = busy === app.id
  return (
    <div className={`app-row${status === 'connected' ? ' on' : ''}`}>
      <SourceMark app={app.id} label={app.label} />
      <div className="app-t">
        <b>{app.label}</b>
        <small>{app.why}</small>
      </div>
      {status === 'connected'
        ? <span className="app-on"><Check size={13} strokeWidth={2.6} /> Connected</span>
        : (
          <button className={`btn sm ${status === 'reauth' ? 'ink' : 'line'}`} disabled={!!busy} onClick={() => onConnect(app)}>
            {waiting ? 'Waiting for sign-in…' : status === 'reauth' ? 'Sign in again' : 'Connect'}
          </button>
        )}
    </div>
  )
}

export function Profile({ name, email, onClose }: { name: string; email: string; onClose: () => void }) {
  const toast = useToast()
  const [org, setOrg] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, Status> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark')
  const accounts = useAccounts()

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

  /** Open the provider's own sign-in, then watch for the account to appear. The window
   *  is opened on the click itself — one opened after an await gets blocked. */
  async function connect(app: App) {
    if (!org) return
    setBusy(app.id)
    const win = window.open('', '_blank', 'width=520,height=680')
    try {
      const out = await signInUrl(app, org)
      if (out.already) { win?.close(); await load(); return }
      const url = out.url
      if (!url) { win?.close(); toast(out.explanation || `${app.label} can’t be connected from here yet`); return }
      if (win) win.location.href = url
      else { toast('Your browser blocked the sign-in window — allow pop-ups and try again'); return }
      // up to three minutes of consent, checked every couple of seconds
      for (let i = 0; i < 90; i++) {
        await sleep(2000)
        try {
          const s = await readStatus(org)
          setStatus(s)
          if (s[app.id] === 'connected') {
            toast(app.id === 'granola' ? `${app.label} connected. Your last few weeks of notes are loading` : `${app.label} connected`)
            // the rest of the app learns of it now, and loads its history (see accounts.ts)
            await accounts.refresh()
            return
          }
        } catch { /* keep waiting */ }
      }
      toast('Still waiting on that one — press refresh once you’ve signed in')
    } catch (e) {
      win?.close()
      toast(`Couldn’t start that — ${(e as Error)?.message ?? 'try again'}`)
    } finally {
      setBusy(null)
    }
  }

  /** One more mailbox of a kind that is already connected: a second Gmail, say. */
  async function addMailbox(kind: Provider) {
    if (busy) return
    setBusy(`add:${kind}`)
    const had = accounts.mail.length
    const win = window.open('', '_blank', 'width=520,height=680')
    try {
      const out = await runFn<{ auth_url?: string; authorization_url?: string; explanation?: string }>('connect_source', { app: kind, add_another: true })
      const url = out.auth_url || out.authorization_url
      if (!url) { win?.close(); toast(out.explanation || 'That could not be started'); return }
      if (win) win.location.href = url
      else { toast('Your browser blocked the sign-in window. Allow pop-ups and try again'); return }
      for (let i = 0; i < 90; i++) {
        await sleep(2000)
        await accounts.refresh()
        const now = await runFn<{ sources?: { app: string; accounts?: unknown[] }[] }>('sources_status', {})
        const n = (now.sources ?? []).filter((s) => s.app === 'gmail' || s.app === 'outlook').reduce((t, s) => t + (s.accounts?.length ?? 0), 0)
        if (n > had) { toast('Mailbox added. Its last three weeks are loading'); await accounts.refresh(); return }
      }
      toast('Still waiting on that one. Press refresh once you’ve signed in')
    } catch (e) {
      win?.close()
      toast(`Couldn’t start that: ${(e as Error)?.message ?? 'try again'}`)
    } finally {
      setBusy(null)
    }
  }

  const toggleTheme = () => {
    const n = dark ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', n)
    try { localStorage.setItem('desk-theme', n) } catch { /* fine */ }
    setDark(!dark)
  }

  const on = (a: App) => status?.[a.id] === 'connected'
  const reading = SOURCES.filter(on).length
  const sections: { title: string; apps: App[] }[] = [
    { title: `${tm()} reads from`, apps: SOURCES },
    { title: `${tm()} writes into`, apps: OUTPUTS },
    { title: 'Worth adding', apps: SUGGESTED },
  ]

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="profile" role="dialog" aria-label="You">
        <div className="profile-h">
          <Avatar name={name} size="lg" />
          <div className="hero-t">
            <h2>{name}</h2>
            <div className="hero-s">{email}</div>
          </div>
          <button className="icon-btn" title={dark ? 'Light' : 'Dark'} onClick={toggleTheme}>{dark ? <SunMedium size={16} /> : <Moon size={16} />}</button>
          <button className="icon-btn" title="Refresh" onClick={() => void load()}><RefreshCw size={15} /></button>
          <button className="icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="profile-b">
          {status === null ? <div className="skel"><div className="skel-row" /><div className="skel-row" style={{ width: '70%' }} /></div> : (
            <>
              <p className="profile-sum">
                {tm()} is reading <b>{reading}</b> of {SOURCES.length} sources
                {SOURCES.some((a) => status[a.id] === 'reauth') && <> · <span className="warn">one needs you to sign in again</span></>}
              </p>
              <ReachSection />
              {accounts.mail.length > 0 && (
                <section className="profile-sec">
                  <div className="sec-h">Your mailboxes</div>
                  <div className="acct-list">
                    {accounts.mail.map((a) => (
                      <div key={a.id} className="acct">
                        <SourceMark app={a.provider} />
                        <div className="acct-t">
                          <b>{accountLabel(a)}</b>
                          <small>{a.provider === 'gmail' ? 'Gmail' : 'Outlook'}</small>
                        </div>
                        {accounts.multi && (accounts.primary?.id === a.id
                          ? <span className="acct-primary" title="New mail and your morning brief go out from here">Primary</span>
                          : <button className="btn sm line" onClick={() => void accounts.setPrimary(a)}>Make primary</button>)}
                      </div>
                    ))}
                  </div>
                  <div className="acct-add">
                    <button className="btn sm line" disabled={!!busy} onClick={() => void addMailbox('gmail')}>{busy === 'add:gmail' ? 'Waiting for sign-in…' : 'Add a Gmail'}</button>
                    <button className="btn sm line" disabled={!!busy} onClick={() => void addMailbox('outlook')}>{busy === 'add:outlook' ? 'Waiting for sign-in…' : 'Add an Outlook'}</button>
                  </div>
                </section>
              )}
              {sections.map((sec) => {
                // connected first, then what still needs doing
                const apps = [...sec.apps].sort((a, b) => Number(on(b)) - Number(on(a)))
                return (
                  <section key={sec.title} className="profile-sec">
                    <div className="sec-h">{sec.title}</div>
                    <div className="app-list">
                      {apps.map((a) => <Row key={a.id} app={a} status={status[a.id]} busy={busy} onConnect={(x) => void connect(x)} />)}
                      {sec.apps === SUGGESTED && <AnyOtherApp />}
                    </div>
                  </section>
                )
              })}
            </>
          )}
        </div>
      </div>
    </>
  )
}

/* ---------------- any other app ---------------- */

/* The lists above are what the desk itself reads and writes. Anything else is connected by
   asking the assistant in Lemma, which can find and connect any app Lemma supports. */
function AnyOtherApp() {
  return (
    <div className="app-row">
      <span className="mark"><Plus size={17} /></span>
      <div className="app-t">
        <b>Any other app</b>
        <small>Ask {tm()} in Lemma to connect it: your CRM, a notes app, a project tracker.</small>
      </div>
      <a className="btn sm line" href={lemmaPodUrl()} target="_blank" rel="noreferrer">Open Lemma</a>
    </div>
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
  const [qr, setQr] = useState<'whatsapp' | null>(null)
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
      if (out.handle) setQr('whatsapp')
      else toast('WhatsApp isn’t available in this workspace yet')
    } catch { toast('WhatsApp couldn’t be set up just now') } finally { setBusy(null) }
  }
  /** Opens Lemma's setup bot in Telegram, on the click itself (a window opened later is
   *  blocked), then waits for the person to name their bot there. */
  async function telegram() {
    if (busy) return
    setBusy('telegram')
    const win = window.open('', '_blank')
    try {
      const s = await startTelegram()
      setSetup(s)
      if (win && !win.closed) { win.opener = null; win.location.href = s.launch_url } else win?.close()
      // naming a bot takes a minute or two; the setup itself runs out in about an hour
      for (let i = 0; i < 400 && alive.current; i++) {
        await sleep(3000)
        const now = await readTelegramSetup(s.setup_id).catch(() => null)
        if (!now) continue
        if (telegramReady(now)) {
          const handle = now.bot_username!
          setR((x) => (x ? { ...x, telegram: { handle: `@${handle.replace(/^@/, '')}`, link: now.bot_launch_url || telegramLink(handle) } } : x))
          toast(`Your Telegram bot is ready: @${handle.replace(/^@/, '')}`)
          return
        }
        if (telegramFailed(now)) { toast(now.error || 'That setup ran out. Start it again'); return }
      }
    } catch (e) {
      win?.close()
      toast(`Telegram couldn’t be set up: ${(e as Error)?.message ?? 'try again'}`)
    } finally {
      if (alive.current) { setSetup(null); setBusy(null) }
    }
  }

  const showWa = wa.offered || !!wa.handle
  if (!r.email && !showWa && !r.telegramOffered) return null
  return (
    <section className="profile-sec">
      <div className="sec-h">Reach {tm()}</div>
      <div className="app-list">
        {r.email && (
          <div className="app-row on">
            <span className="mark"><Mail size={17} /></span>
            <div className="app-t">
              <b className="reach-addr">{r.email}</b>
              <small>Write or forward anything. Your morning brief comes from here, and a reply to it reaches {tm()}.</small>
            </div>
            <button className="btn sm line" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
        {showWa && (
          <div className={`app-row${wa.handle ? ' on' : ''}`}>
            <SourceMark app="whatsapp" label="WhatsApp" />
            <div className="app-t">
              <b>WhatsApp{wa.handle ? ` · ${wa.handle}` : ''}</b>
              <small>{!wa.handle
                ? `Message ${tm()} from your phone.`
                : wa.mine
                  ? `Write from your number ending ${lastFour(wa.mine)}; it is already linked.`
                  : 'The first time, it asks for your email and sends a code there.'}</small>
            </div>
            {wa.handle ? (
              <span className="reach-acts">
                <button className="btn sm line" onClick={() => setQr(qr ? null : 'whatsapp')}>{qr ? 'Hide code' : 'Code'}</button>
                <a className="btn sm line" href={whatsAppWebLink(wa.handle, hello)} target="_blank" rel="noreferrer">Open</a>
              </span>
            ) : (
              <button className="btn sm line" disabled={!!busy} onClick={() => void whatsapp()}>{busy === 'whatsapp' ? 'Setting up…' : 'Set up'}</button>
            )}
          </div>
        )}
        {qr === 'whatsapp' && wa.handle && (
          <div className="reach-qr-row">
            <Qr text={whatsAppLink(wa.handle, hello)} label={`QR code that opens a WhatsApp chat with ${wa.handle}`} />
            <small>Scan with your phone’s camera. The message is ready to send.</small>
          </div>
        )}
        {(r.telegram || r.telegramOffered) && (
          <div className={`app-row${r.telegram ? ' on' : ''}`}>
            <SourceMark app="telegram" label="Telegram" />
            <div className="app-t">
              <b>Telegram{r.telegram?.handle ? ` · ${r.telegram.handle}` : ''}</b>
              <small>{r.telegram
                ? `Your own bot for ${tm()}. Message it like a person.`
                : setup
                  ? 'Name your bot in Telegram. This updates by itself when it’s made.'
                  : `A bot of your own for ${tm()}, made inside Telegram in a minute.`}</small>
            </div>
            {r.telegram?.link
              ? <a className="btn sm line" href={r.telegram.link} target="_blank" rel="noreferrer">Open</a>
              : !r.telegram && <button className="btn sm line" disabled={!!busy} onClick={() => void telegram()}>{busy === 'telegram' ? 'Waiting for Telegram…' : 'Set up'}</button>}
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
      </div>
    </section>
  )
}
