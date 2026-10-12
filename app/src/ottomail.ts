import { client } from './lib'

/* The assistant's own email address.

   Every pod's assistant is given an address by Lemma when the pod is made. The morning brief
   goes out from it, so that a reply reaches the assistant and gets acted on; a brief sent
   from the person's own mailbox to themselves has nobody listening on the other end.

   Two things have to be true of that address, and neither is the default on a new pod, so
   the app arranges them on every launch (it changes nothing once they hold):
     1. it may write first. Without this it can only answer, and the brief never leaves;
     2. it answers this person. The list of addresses it answers is kept to the people who
        use this pod, so a stranger who learns the address gets nothing back. */

type Config = {
  send_policy?: { allow_send?: boolean } | null
  identity?: { allowed_email_addresses?: string[]; allowed_domains?: string[] } | null
}
type Surface = { name?: string; platform?: string; is_enabled?: boolean; config?: Config | null; reach?: { email?: string | null } | null }
type Sdk = {
  podId?: string; _podId?: string
  users: { current: () => Promise<{ email?: string | null }> }
  podSurfaces: {
    list: (pod: string, o?: { platform?: string }) => Promise<{ items?: Surface[] }>
    update: (pod: string, name: string, p: Record<string, unknown>) => Promise<Surface>
  }
}
const sdk = () => client as unknown as Sdk
const pod = () => String(sdk().podId ?? sdk()._podId ?? '')

/** The address the assistant writes from, or null when this pod has none. */
export async function ensureOttoMail(): Promise<string | null> {
  const [out, me] = await Promise.all([
    sdk().podSurfaces.list(pod(), { platform: 'RESEND' }),
    sdk().users.current().then((u) => (u.email || '').trim().toLowerCase()).catch(() => ''),
  ])
  const s = (out.items ?? []).find((x) => (x.platform || '').toUpperCase() === 'RESEND')
  if (!s?.name) return null

  const allowed = (s.config?.identity?.allowed_email_addresses ?? []).map((a) => a.toLowerCase())
  const maySend = s.config?.send_policy?.allow_send === true
  const answersMe = !me || allowed.includes(me)
  if (!maySend || !answersMe) {
    await sdk().podSurfaces.update(pod(), s.name, {
      config: {
        send_policy: { allow_send: true },
        identity: { allowed_email_addresses: answersMe ? allowed : [...allowed, me] },
      },
    })
  }
  return s.reach?.email ?? null
}
