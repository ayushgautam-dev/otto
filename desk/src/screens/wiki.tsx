import { useCallback, useEffect, useState } from 'react'
import { PenLine, Sparkles } from 'lucide-react'
import { Empty, Loading, Markdown, Orb, useToast } from '../ui'
import { tm } from '../teammate'
import { getSetting, putSetting, runWorkflow } from '../backfill'
import { ABOUT, VOICE, BUSINESS, UPDATES, readText, writeText, parse, render, withEdit, lastUpdated, foldEdits, asEdits, type Wiki as WikiDoc } from '../wiki'

/* Your wiki: what the assistant understands about you, written from your mail and meetings
   and kept current every night. Every section can be edited in place; what you write wins
   over what it learned. How you write sits with it: your own rules (editable) above what
   was learned from your sent mail (shown, relearned monthly). */

function Editable({ heading, body, hint, onSave }: {
  heading: string; body: string; hint?: string; onSave: (text: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  async function save() {
    if (draft === null) return
    setSaving(true)
    try { await onSave(draft); setDraft(null) }
    catch (e) { toast(`Not saved: ${(e as Error)?.message ?? 'try again'}`) }
    finally { setSaving(false) }
  }
  return (
    <section className="wiki-sec">
      <div className="wiki-sec-h">
        <h2>{heading}</h2>
        {draft === null && <button className="link-q" onClick={() => setDraft(body)}><PenLine size={12} /> Edit</button>}
      </div>
      {draft === null
        ? (body.trim() ? <div className="wiki-body"><Markdown text={body} /></div> : <p className="wiki-none">{hint ?? 'Nothing here yet.'}</p>)
        : (
          <div className="wiki-edit">
            <textarea autoFocus value={draft} rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save() }} />
            <div className="wiki-edit-foot">
              <button className="link-q" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn sm ink" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}
    </section>
  )
}

export function Wiki() {
  const toast = useToast()
  const [about, setAbout] = useState<WikiDoc | null | undefined>(undefined)
  const [rules, setRules] = useState('')
  const [learned, setLearned] = useState<string | null>(null)
  const [business, setBusiness] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  const load = useCallback(async () => {
    const [a, r, v, b] = await Promise.all([readText(ABOUT), getSetting('voice_doc').catch(() => null), readText(VOICE), readText(BUSINESS)])
    setAbout(a ? parse(a) : null)
    setRules(r?.value ?? '')
    setLearned(v)
    setBusiness(b)
  }, [])
  useEffect(() => { void load() }, [load])

  async function writeNow() {
    setWriting(true)
    try {
      const done = await runWorkflow('autopilot_wiki', 6 * 60_000)
      await load()
      if (!done) toast(`${tm()} is still writing it. It will be here when you come back`)
    } catch { toast('That couldn’t be started just now') }
    finally { setWriting(false) }
  }
  async function saveSection(heading: string, text: string) {
    if (!about) return
    const before = about.sections.find((s) => s.heading === heading)?.body ?? ''
    const next = withEdit(about, heading, text)
    await writeText(ABOUT, render(next))
    // which words are theirs, so the nightly pass keeps them and revises only its own
    const prev = asEdits((await getSetting('wiki_edits').catch(() => null))?.value)
    await putSetting('wiki_edits', JSON.stringify(foldEdits(prev, before, text))).catch(() => null)
    setAbout(next)
  }

  const updated = about ? lastUpdated(about) : null
  const main = about?.sections.filter((s) => s.heading !== UPDATES) ?? []
  const log = about?.sections.find((s) => s.heading === UPDATES)

  return (
    <div className="page wiki">
      <header className="page-h">
        <h1 className="display sm">Wiki</h1>
        <span className="muted">What {tm()} knows about you{updated ? ` · updated ${updated}` : ''}</span>
      </header>
      {about === undefined ? <Loading rows={4} /> : (
        <div className="wiki-cols">
          <div className="wiki-main">
            {about === null
              ? (writing
                ? <div className="writing" role="status"><Orb live size={20} /><div><b>{tm()} is writing it…</b><span>From your mail and meetings. You can carry on.</span></div></div>
                : <Empty line={`${tm()} writes this from your mail and meetings, then keeps it current every night.`}
                    action={<button className="btn spark" onClick={() => void writeNow()}><Sparkles size={13} /> Write it now</button>} />)
              : main.map((s) => (
                <Editable key={s.heading} heading={s.heading} body={s.body} onSave={(t) => saveSection(s.heading, t)} />
              ))}

            <Editable heading="How you write" body={rules}
              hint={`Your own rules: greeting, sign-off, words you never use. ${tm()} follows these over anything it learned.`}
              onSave={async (t) => { await putSetting('voice_doc', t.trim()); setRules(t.trim()) }} />
            {learned && (
              <details className="wiki-learned">
                <summary>Learned from your sent mail</summary>
                <div className="wiki-body"><Markdown text={learned.replace(/^#\s.*\n/, '')} /></div>
                <p className="wiki-none">Relearned every month. To change something here, add a rule above.</p>
              </details>
            )}

            {business && (
              <Editable heading="Business details" body={business.replace(/^#\s.*\n/, '').trim()}
                onSave={async (t) => {
                  const head = /^#\s.*\n/.exec(business)?.[0] ?? ''
                  await writeText(BUSINESS, `${head}${head ? '\n' : ''}${t.trim()}\n`)
                  setBusiness(`${head}${head ? '\n' : ''}${t.trim()}\n`)
                }} />
            )}
          </div>
          {log && (
            <aside className="wiki-log">
              <div className="sec-h">{UPDATES}</div>
              <div className="wiki-body"><Markdown text={log.body} /></div>
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
