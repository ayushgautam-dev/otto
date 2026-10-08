import { useCallback } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { sql, lit, ageLabel } from './lib'
import { useLemPanel } from './asklem'
import { Empty } from './ui'

/* Work the person asked for with "Do". Each piece gets a conversation of its own and a
   row in `tasks`; the row says whether it is running, ready to look at, or done, and
   finished work stays listed so a task never just disappears. */

export type TaskRow = { id: string; title: string; status: string; thread_ref?: string | null; updated_at?: string | null }

/** Open the conversation a piece of asked-for work is happening in. */
export function useOpenTask() {
  const panel = useLemPanel()
  return useCallback(async (t: TaskRow) => {
    const key = (t.thread_ref ?? '').startsWith('chat:') ? t.thread_ref!.slice(5) : `task:${t.id}`
    let title = t.title
    try {
      const rows = await sql<{ title: string }>(`select title from chat_threads where scope_key=${lit(key)} limit 1`)
      title = rows[0]?.title || title
    } catch { /* the task's own title will do */ }
    panel.open({ key, title, about: `a piece of work they asked for: "${t.title}"` })
  }, [panel])
}

const GROUPS: { status: string; label: string }[] = [
  { status: 'working', label: 'Running' }, { status: 'drafted', label: 'Ready to look at' }, { status: 'done', label: 'Done' },
]

export function Asked({ tasks }: { tasks: TaskRow[] }) {
  const openTask = useOpenTask()
  if (!tasks.length) return <Empty line="Nothing asked yet. Switch the box on the Feed to Do." />
  return (
    <>
      {GROUPS.map((g) => {
        const own = tasks.filter((t) => t.status === g.status)
        if (!own.length) return null
        return (
          <section key={g.status} className="asked-sec">
            <div className="asked-h">{g.label}</div>
            {own.map((t) => (
              <button key={t.id} className={`asked-r is-${t.status}`} onClick={() => void openTask(t)}>
                {t.status === 'working' ? <span className="pulse" /> : <Check size={14} strokeWidth={2.6} />}
                <span className="asked-t">{t.title}</span>
                <span className="asked-w">{ageLabel(t.updated_at)}</span>
                <ChevronRight size={14} />
              </button>
            ))}
          </section>
        )
      })}
    </>
  )
}

