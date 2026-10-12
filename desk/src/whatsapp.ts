import qrcode from 'qrcode-generator'
import { client } from './lib'

/* WhatsApp, offered during first run.

   On Lemma a pod can answer on WhatsApp through a number Lemma runs. The person does all of
   it from their phone: they message that number, and
     - if the mobile number on their Lemma profile is the one they wrote from, they are
       recognised and the conversation simply starts;
     - if it is not, the number asks for their email, sends a code there, and links the
       phone to their account once the code comes back.
   So the app never asks for a phone number. It shows where to write: a QR code for the
   phone and a link for WhatsApp on the web, both opening a chat with a first message ready.
   What the app does have to arrange, and only once the person reaches that card:
     1. the pod gets a WhatsApp surface, if it has none yet;
     2. this pod is made the one that answers them on WhatsApp (somebody in several pods
        shares the one number, and one of them has to be the default). */

export interface WhatsApp {
  /** the person's own number, as saved on their profile; null means the number will ask for their email */
  mine: string | null
  /** the number to message; null until the pod has a WhatsApp surface */
  handle: string | null
  surfaceId: string | null
  /** false when this workspace cannot offer WhatsApp at all: the card is then not shown */
  offered: boolean
}

type Surface = { id?: string; platform?: string; reach?: { handle?: string | null } | null; surface_identity_username?: string | null }
type Available = { platform?: string; supported_credential_modes?: string[]; system_claim?: { available?: boolean } | null }
type Sdk = {
  podId?: string; _podId?: string
  users: { getProfile: () => Promise<{ mobile_number?: string | null }> }
  podSurfaces: {
    available: (pod: string) => Promise<{ items?: Available[]; surfaces?: Available[] }>
    list: (pod: string, o?: { platform?: string }) => Promise<{ items?: Surface[] }>
    create: (pod: string, p: Record<string, unknown>) => Promise<Surface>
  }
  userSurfaces: { setDefault: (p: { platform: string; surface_id: string }) => Promise<unknown> }
}
const sdk = () => client as unknown as Sdk
const pod = () => String(sdk().podId ?? sdk()._podId ?? '')
const isWa = (p?: string) => (p || '').toUpperCase() === 'WHATSAPP'
const handleOf = (s?: Surface | null) => s?.reach?.handle || s?.surface_identity_username || null
const NONE: WhatsApp = { mine: null, handle: null, surfaceId: null, offered: false }

async function surface(): Promise<Surface | null> {
  const out = await sdk().podSurfaces.list(pod(), { platform: 'WHATSAPP' })
  return (out.items ?? []).find((s) => isWa(s.platform)) ?? null
}

/** Lemma's number can sit behind one pod per organisation. False when another pod has it. */
async function canClaim(): Promise<boolean> {
  try {
    const out = await sdk().podSurfaces.available(pod())
    const wa = (out.items ?? out.surfaces ?? []).find((a) => isWa(a.platform))
    if (!wa) return false
    if (wa.supported_credential_modes && !wa.supported_credential_modes.includes('SYSTEM')) return false
    return wa.system_claim?.available !== false
  } catch { return true }
}

const myNumber = () => sdk().users.getProfile().then((p) => p.mobile_number || null).catch(() => null)

/** Reading changes nothing. */
export async function readWhatsApp(): Promise<WhatsApp> {
  try {
    const [mine, s] = await Promise.all([myNumber(), surface()])
    if (!s) return { ...NONE, mine, offered: await canClaim() }
    return { mine, handle: handleOf(s), surfaceId: s.id ?? null, offered: true }
  } catch {
    return NONE
  }
}

/** Gives the pod its WhatsApp surface if it has none, and makes it the one that answers this person. */
export async function setUpWhatsApp(): Promise<WhatsApp> {
  let s = await surface()
  if (!s) {
    s = await sdk().podSurfaces.create(pod(), {
      platform: 'WHATSAPP', credential_mode: 'SYSTEM', default_agent_name: 'pod_default', is_enabled: true,
    })
  }
  if (s?.id) await sdk().userSurfaces.setDefault({ platform: 'WHATSAPP', surface_id: s.id }).catch(() => null)
  return { mine: await myNumber(), handle: handleOf(s), surfaceId: s?.id ?? null, offered: true }
}

/** The first message, ready to send. A linked number gets an answer; an unlinked one is asked for its email first. */
export const firstMessage = (teammate: string) => `Hi ${teammate}, let's get started`

const digits = (handle: string) => handle.replace(/\D/g, '')

/** Opens the chat in the WhatsApp app. This is what the QR code holds. */
export const whatsAppLink = (handle: string, text: string) =>
  `https://wa.me/${digits(handle)}?text=${encodeURIComponent(text)}`

/** Opens the same chat in WhatsApp on the web, for somebody who stays on their computer. */
export const whatsAppWebLink = (handle: string, text: string) =>
  `https://web.whatsapp.com/send?phone=${digits(handle)}&text=${encodeURIComponent(text)}`

/** A QR code as one SVG path on a `size` by `size` grid, quiet zone included. */
export function qrPath(text: string): { d: string; size: number } {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const pad = 2
  let d = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + pad} ${y + pad}h1v1h-1z`
  return { d, size: n + pad * 2 }
}

export const lastFour = (n: string) => n.replace(/\D/g, '').slice(-4)
