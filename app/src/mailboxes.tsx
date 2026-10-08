import { useState } from 'react'
import { X } from 'lucide-react'
import { runFn } from './lib'
import { useToast } from './ui'
import { SourceMark } from './brand'
import { useAccounts, accountLabel, type Provider } from './accounts'

/* Your mailboxes: every address connected, which one new mail and the morning brief go
   out from, and a way to add another. Opened from your name at the foot of the rail. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function Mailboxes({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const accounts = useAccounts()
  const [busy, setBusy] = useState<Provider | null>(null)

  /** Connect a mailbox: the first of its kind, or one more beside it. */
  async function add(kind: Provider) {
    if (busy) return
    setBusy(kind)
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

  return (
    <>
      <div className="mbx-scrim" onClick={onClose} />
      <div className="mbx" role="dialog" aria-label="Your mailboxes">
        <div className="mbx-h">
          <b>Your mailboxes</b>
          <button className="btn quiet" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
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
          <button className="btn" disabled={!!busy} onClick={() => void add('gmail')}>{busy === 'gmail' ? 'Waiting for sign-in…' : 'Add a Gmail'}</button>
          <button className="btn" disabled={!!busy} onClick={() => void add('outlook')}>{busy === 'outlook' ? 'Waiting for sign-in…' : 'Add an Outlook'}</button>
        </div>
      </div>
    </>
  )
}
