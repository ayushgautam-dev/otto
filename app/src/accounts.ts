import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { runFn, useSql, lit } from './lib'
import { getSetting, putSetting, restartCatchUp } from './backfill'

/* The person's mailboxes.
   Somebody may connect several: two Gmails, a Gmail and an Outlook. Everything still
   lands on one desk. What the app needs to know is small:
   - which mailboxes are mine (asked of the pod, which only ever answers with MY accounts);
   - which one new mail and the morning brief go out from (the primary, their choice);
   - which mailbox a given conversation lives in, so a reply leaves from the same place.
   With a single mailbox none of this shows anywhere. */

export type Provider = 'gmail' | 'outlook'
export interface MailAccount { id: string; email: string; provider: Provider }

interface SourceOut { app: string; connected?: boolean; accounts?: { id: string; email: string; default?: boolean }[] }

const PRIMARY = 'primary_mail_account'      // "gmail:<account id>" | "outlook:<account id>"

async function load(): Promise<{ mail: MailAccount[]; sources: string[]; primary: string }> {
  const out = await runFn<{ sources?: SourceOut[] }>('sources_status', {})
  const all = out.sources ?? []
  const mail: MailAccount[] = []
  for (const s of all) {
    if (s.app !== 'gmail' && s.app !== 'outlook') continue
    for (const a of s.accounts ?? []) mail.push({ id: a.id, email: a.email, provider: s.app })
  }
  const primary = (await getSetting(PRIMARY))?.value ?? ''
  return { mail, sources: all.filter((s) => s.connected).map((s) => s.app), primary }
}

export function useAccounts() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['accounts'], queryFn: load, staleTime: 60_000 })
  const mail = q.data?.mail ?? []
  const chosen = q.data?.primary ?? ''
  const primary = mail.find((a) => `${a.provider}:${a.id}` === chosen) ?? mail[0] ?? null
  return {
    mail, primary,
    /** more than one mailbox: the only time any of this is shown */
    multi: mail.length > 1,
    sources: q.data?.sources ?? [],
    refresh: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
    setPrimary: async (a: MailAccount) => {
      await putSetting(PRIMARY, `${a.provider}:${a.id}`)
      await qc.invalidateQueries({ queryKey: ['accounts'] })
    },
  }
}

/** Which of my mailboxes a conversation lives in. Null for one that predates accounts
 *  being recorded, which then goes through the default mailbox as it always did. */
export function useThreadAccount(threadRef?: string | null): MailAccount | null {
  const { mail } = useAccounts()
  const q = useSql<{ account_id: string }>(threadRef
    ? `select account_id from interactions where thread_ref=${lit(threadRef)} and account_id is not null limit 1`
    : null)
  return resolveAccount(threadRef, q.items[0]?.account_id, mail)
}

/** The mailbox a conversation belongs to. Rows written before accounts were recorded
 *  carry no account; those belong to the person's only mailbox of that kind, when they
 *  have exactly one (a Gmail thread to their one Gmail, an Outlook one to their one Outlook). */
export function resolveAccount(threadRef: string | null | undefined, accountId: string | null | undefined, mail: MailAccount[]): MailAccount | null {
  const known = mail.find((a) => a.id === accountId)
  if (known || !threadRef) return known ?? null
  const kind: Provider | null = threadRef.startsWith('outlook:') ? 'outlook' : /^[0-9a-f]{10,24}$/.test(threadRef) ? 'gmail' : null
  const same = mail.filter((a) => a.provider === kind)
  return same.length === 1 ? same[0] : null
}

/** A short name for a mailbox: its address, which is what tells two of them apart. */
export const accountLabel = (a: MailAccount) => a.email || (a.provider === 'gmail' ? 'Gmail' : 'Outlook')

/* A mailbox connected after first run brings its own three weeks of history. The app
   remembers which accounts it has seen; a new one restarts the background catch-up
   (rows already loaded are skipped, so only the new mailbox costs anything). */
export function useNewAccountCatchUp() {
  const { mail, sources } = useAccounts()
  const ids = mail.map((a) => a.id).sort().join(',')
  useEffect(() => {
    if (!ids) return
    void (async () => {
      const seen = (await getSetting('accounts_seen'))?.value
      if (seen === ids) return
      await putSetting('accounts_seen', ids)
      // nothing recorded yet means this is the first look, not a new account
      if (seen == null || !(await getSetting('onboarded_at'))?.value) return
      const before = new Set(seen.split(','))
      if (ids.split(',').some((id) => !before.has(id))) await restartCatchUp(sources)
    })()
  }, [ids])
}
