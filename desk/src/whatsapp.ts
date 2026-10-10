import { client } from './lib'

/* WhatsApp, offered during first run.

   On Lemma a pod can answer on WhatsApp through a number Lemma runs. Nothing is installed
   and no account is linked: the person is recognised by the mobile number on their own
   Lemma profile, and simply messages the pod's number. So setting it up is three small
   things, all done here and only when the person asks for them:
     1. the pod gets a WhatsApp surface, if it has none yet;
     2. their number is saved to their profile, if it is not there;
     3. this pod is made the one that answers them on WhatsApp (somebody in several pods
        shares the one number, and one of them has to be the default).
   Nothing here runs by itself: reading the state changes nothing. */

export interface WhatsApp {
  /** the person's own number, as saved on their profile */
  mine: string | null
  /** the number to message; null until the pod has a WhatsApp surface */
  handle: string | null
  surfaceId: string | null
  /** false when this workspace cannot offer WhatsApp at all: the card is then not shown */
  offered: boolean
}

type Surface = { id?: string; platform?: string; reach?: { handle?: string | null } | null; surface_identity_username?: string | null }
type Sdk = {
  podId?: string; _podId?: string
  users: { getProfile: () => Promise<{ mobile_number?: string | null }>; upsertProfile: (p: { mobile_number: string }) => Promise<unknown> }
  podSurfaces: {
    list: (pod: string, o?: { platform?: string }) => Promise<{ items?: Surface[] }>
    create: (pod: string, p: Record<string, unknown>) => Promise<Surface>
  }
  userSurfaces: { setDefault: (p: { platform: string; surface_id: string }) => Promise<unknown> }
}
const sdk = () => client as unknown as Sdk
const pod = () => String(sdk().podId ?? sdk()._podId ?? '')
const handleOf = (s?: Surface | null) => s?.reach?.handle || s?.surface_identity_username || null

async function surface(): Promise<Surface | null> {
  const out = await sdk().podSurfaces.list(pod(), { platform: 'WHATSAPP' })
  return (out.items ?? []).find((s) => (s.platform || '').toUpperCase() === 'WHATSAPP') ?? null
}

export async function readWhatsApp(): Promise<WhatsApp> {
  try {
    const [me, s] = await Promise.all([sdk().users.getProfile().catch(() => ({ mobile_number: null })), surface()])
    return { mine: me.mobile_number || null, handle: handleOf(s), surfaceId: s?.id ?? null, offered: true }
  } catch {
    return { mine: null, handle: null, surfaceId: null, offered: false }
  }
}

/** Does the three things above. `mobile` is only needed when the profile has no number. */
export async function setUpWhatsApp(mobile?: string): Promise<WhatsApp> {
  const number = (mobile || '').replace(/[^\d+]/g, '')
  if (number) await sdk().users.upsertProfile({ mobile_number: number })
  let s = await surface()
  if (!s) {
    s = await sdk().podSurfaces.create(pod(), {
      platform: 'WHATSAPP', credential_mode: 'SYSTEM', default_agent_name: 'pod_default', is_enabled: true,
    })
  }
  if (s?.id) await sdk().userSurfaces.setDefault({ platform: 'WHATSAPP', surface_id: s.id }).catch(() => null)
  const me = await sdk().users.getProfile().catch(() => ({ mobile_number: number || null }))
  return { mine: me.mobile_number || number || null, handle: handleOf(s), surfaceId: s?.id ?? null, offered: true }
}

/** Opens a chat with the pod's number, with a first message ready to send. */
export const whatsAppLink = (handle: string) =>
  `https://wa.me/${handle.replace(/\D/g, '')}?text=${encodeURIComponent('Hi')}`

export const lastFour = (n: string) => n.replace(/\D/g, '').slice(-4)
