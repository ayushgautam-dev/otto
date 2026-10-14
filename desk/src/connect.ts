import { client, runFn } from './lib'

/* Every app the assistant works with: what's connected, what isn't, and a few worth adding.
   Shared verbatim by both apps' "You" panel.

   Status is read straight from the organisation's connected accounts, matched on the
   install's name (Granola is an install called "granola" on the shared "mcp" connector,
   so the connector id alone can't tell it apart).

   Connecting goes two ways:
   - The sources the pod already reads go through `connect_source`, exactly as first run
     does — it installs what's missing and hands back the provider's sign-in page.
   - The suggestions go straight to the platform (enable the app, open a connect request).
     Nothing reads them automatically yet; the assistant can use them when asked. */

export interface App { id: string; label: string; why: string; via: 'pod' | 'native'; connector?: string }

// what the assistant reads to find what's unfinished
export const SOURCES: App[] = [
  { id: 'gmail', label: 'Gmail', why: 'Threads, who spoke last, and what was asked of you.', via: 'pod' },
  { id: 'google_calendar', label: 'Google Calendar', why: 'Who you’re meeting, and what was agreed but never booked.', via: 'pod' },
  { id: 'outlook', label: 'Outlook', why: 'Mail and calendar, for work that lives in Microsoft 365. Connect it if your Teams meetings sit on a Microsoft calendar: they are not in Google Calendar, even when your phone shows the two together.', via: 'pod' },
  { id: 'granola', label: 'Granola', why: 'Meeting notes and action items — where a promise made out loud gets written down.', via: 'pod' },
  { id: 'googlemeet', label: 'Google Meet', why: 'Call transcripts, where Meet recorded one.', via: 'pod' },
  { id: 'slack', label: 'Slack', why: 'The channels you invited the app to, where the day’s asks land.', via: 'native', connector: 'slack' },
]
// where the assistant puts finished work
export const OUTPUTS: App[] = [
  { id: 'google_docs', label: 'Google Docs', why: 'Documents open as real Google Docs.', via: 'pod' },
  { id: 'google_drive', label: 'Google Drive', why: 'Share a document with just the people it’s for.', via: 'pod' },
]
// worth adding for this kind of work
export const SUGGESTED: App[] = [
  { id: 'zoom', label: 'Zoom', why: 'Calls outside Google Meet — where half the promises are made out loud.', via: 'native', connector: 'zoom' },
  { id: 'calendly', label: 'Calendly', why: 'Offer your booking link instead of trading times by email.', via: 'native', connector: 'calendly' },
]

export type Status = 'connected' | 'reauth' | 'off'

export async function orgId(): Promise<string | null> {
  const c = client as unknown as { podId?: string; config?: { podId?: string }; pods: { get: (id: string) => Promise<{ organization_id?: string }> } }
  const pod = c.podId || c.config?.podId
  if (!pod) return null
  try { return (await c.pods.get(pod)).organization_id ?? null } catch { return null }
}

/** install name → how its account stands */
export async function readStatus(org: string): Promise<Record<string, Status>> {
  const conn = client.connectors as unknown as {
    accounts: { list: (o: string) => Promise<{ items?: { auth_config_id: string; status: string }[] }> }
    authConfigs: { list: (o: string, opts?: { limit: number }) => Promise<{ items?: { id: string; name: string }[] }> }
  }
  const [cfgs, accts] = await Promise.all([conn.authConfigs.list(org, { limit: 100 }), conn.accounts.list(org)])
  const nameOf = new Map((cfgs.items ?? []).map((c) => [String(c.id), String(c.name).toLowerCase()]))
  const out: Record<string, Status> = {}
  for (const a of accts.items ?? []) {
    const n = nameOf.get(String(a.auth_config_id))
    if (!n) continue
    const s: Status = a.status === 'CONNECTED' ? 'connected' : a.status === 'REAUTH_REQUIRED' || a.status === 'EXPIRED' ? 'reauth' : 'off'
    if (out[n] !== 'connected') out[n] = s
  }
  return out
}

/** The provider's sign-in page for `app`, or why there is none. */
export async function signInUrl(app: App, org: string): Promise<{ url?: string | null; already?: boolean; explanation?: string }> {
  if (app.via === 'pod') {
    const out = await runFn<{ auth_url?: string; authorization_url?: string; already_connected?: boolean; explanation?: string }>('connect_source', { app: app.id })
    if (out.already_connected) return { already: true }
    return { url: out.auth_url || out.authorization_url, explanation: out.explanation }
  }
  const conn = client.connectors as unknown as {
    enableApp: (o: string, id: string, opts?: { name?: string }) => Promise<{ id: string }>
    createConnectRequest: (o: string, i: { connector_id: string; auth_config_id?: string }) => Promise<{ authorization_url?: string | null }>
  }
  const cfg = await conn.enableApp(org, app.connector!, { name: app.id })
  return { url: (await conn.createConnectRequest(org, { connector_id: app.connector!, auth_config_id: cfg.id })).authorization_url }
}
