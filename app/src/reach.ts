import { client } from './lib'
import { readWhatsApp, type WhatsApp } from './whatsapp'

/* Every way the person can reach their assistant outside this app. Lemma gives every pod's
   assistant these channels; this file only finds them and sets them up.
   - Email: the address Lemma gave the assistant when the pod was made. ottomail.ts makes
     sure it may write first and answers this person; here it is only read.
   - WhatsApp: Lemma's own number, behind one pod per person (whatsapp.ts).
   - Telegram: a bot of the person's own. Lemma's setup bot makes it inside Telegram: they
     open the link, name the bot, and it binds to this pod by itself, with no token to copy
     back. The bot does not exist until that is done, so the caller waits for it.
   This file is shared verbatim by both apps. */

export interface TelegramBot { handle: string | null; link: string | null }
export interface Reach {
  /** the assistant's own address; null when this pod has none */
  email: string | null
  whatsapp: WhatsApp
  /** null until the person has made their bot */
  telegram: TelegramBot | null
  /** false when this workspace cannot make a Telegram bot at all: the row is then not shown */
  telegramOffered: boolean
}

export interface TelegramSetup {
  setup_id: string
  /** opens Lemma's setup bot in Telegram, with this pod's setup already started */
  launch_url: string
  status: string
  bot_username?: string | null
  bot_launch_url?: string | null
  error?: string | null
  expires_at?: string
}

type Surface = {
  platform?: string; is_enabled?: boolean
  reach?: { email?: string | null; handle?: string | null } | null
  surface_identity_username?: string | null; surface_identity_email?: string | null
}
type Available = { platform?: string; supported_credential_modes?: string[] }
type Sdk = {
  podId?: string; _podId?: string
  authUrl?: string
  podSurfaces: {
    list: (pod: string, o?: { platform?: string }) => Promise<{ items?: Surface[] }>
    available: (pod: string) => Promise<{ items?: Available[]; surfaces?: Available[] }>
    startTelegramBotSetup: (pod: string, p: Record<string, unknown>) => Promise<TelegramSetup>
    getTelegramBotSetup: (pod: string, id: string) => Promise<TelegramSetup>
  }
}
const sdk = () => client as unknown as Sdk
const pod = () => String(sdk().podId ?? sdk()._podId ?? '')
const is = (p: string | undefined, want: string) => (p || '').toUpperCase() === want
const bare = (h: string) => h.replace(/^@/, '').trim()
export const telegramLink = (handle: string) => `https://t.me/${bare(handle)}`

/** Reading changes nothing. */
export async function readReach(): Promise<Reach> {
  const [list, whatsapp, avail] = await Promise.all([
    sdk().podSurfaces.list(pod()).catch(() => ({ items: [] as Surface[] })),
    readWhatsApp(),
    sdk().podSurfaces.available(pod()).catch(() => null),
  ])
  const items = list.items ?? []
  const mail = items.find((s) => is(s.platform, 'RESEND') && s.is_enabled !== false)
  const tg = items.find((s) => is(s.platform, 'TELEGRAM') && s.is_enabled !== false)
  const handle = tg ? tg.reach?.handle || tg.surface_identity_username || null : null
  const offered = (avail?.items ?? avail?.surfaces ?? []).some((a) => is(a.platform, 'TELEGRAM'))
  return {
    email: mail?.reach?.email || mail?.surface_identity_email || null,
    whatsapp,
    telegram: tg ? { handle: handle ? `@${bare(handle)}` : null, link: handle ? telegramLink(handle) : null } : null,
    // when the catalog cannot be read, offer it: the setup itself says if it is not possible
    telegramOffered: !!tg || avail === null || offered,
  }
}

/** Starts making the person's bot. Open `launch_url` (or show it as a QR code for the phone). */
export const startTelegram = () =>
  sdk().podSurfaces.startTelegramBotSetup(pod(), { default_agent_name: 'pod_default', is_enabled: true })

export const readTelegramSetup = (id: string) => sdk().podSurfaces.getTelegramBotSetup(pod(), id)
export const telegramReady = (s: TelegramSetup) => !!s.bot_username
export const telegramFailed = (s: TelegramSetup) =>
  !!s.error || /FAIL|EXPIRE|ERROR|CANCEL/i.test(s.status || '') || (!!s.expires_at && Date.parse(s.expires_at) < Date.now())

/** Lemma's own view of this pod, where the assistant can connect any other app. */
export function lemmaPodUrl(): string {
  let origin = 'https://lemma.work'
  try { if (sdk().authUrl) origin = new URL(sdk().authUrl!).origin } catch { /* the default */ }
  return `${origin}/pod/${pod()}`
}
