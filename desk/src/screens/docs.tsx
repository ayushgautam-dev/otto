import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useSql, rev, fmtDate } from '../lib'
import { Empty, Loading } from '../ui'
import { useNav } from '../nav'
import { tm } from '../teammate'
import { ArtCard, artType, type ArtRow, type ArtType } from '../artifacts'

/* Everything Lem wrote, shelved where it belongs: under the workstream, company or person
   it came out of, and only then by kind. Each one is drawn as itself — a page, a sheet, a
   deck — and opens full size in the viewer. */

interface Doc extends ArtRow {
  created_at: string; kind: string; status: string
  bucket: string; bucket_kind: 'workstream' | 'company' | 'person' | 'kind'
}

const KIND_FOLDER: Record<string, string> = {
  research: 'Research', brief: 'Briefs', meeting: 'Meeting notes', notes: 'Meeting notes', summary: 'Summaries',
}

// the body is cut for the thumbnail; its blanks are counted on the whole of it
const DOCS_SQL = `
  select d.id, d.title, d.created_at, d.format, d.doc_url, d.file_path, d.loop_id,
         coalesce(d.kind,'') as kind, coalesce(d.status,'') as status,
         left(coalesce(d.body,''), 2400) as body,
         (select count(*) from regexp_matches(coalesce(d.body,''), '\\[(\\.\\.\\.|…)[^\\]\\n]*\\](?!\\()', 'g')) as blanks,
         coalesce(p.name, '') as person, coalesce(c.name, '') as company,
         coalesce(w.title, c.name, p.name, '') as bucket,
         case when w.title is not null then 'workstream'
              when c.name  is not null then 'company'
              when p.name  is not null then 'person'
              else 'kind' end as bucket_kind
  from deliverables d
  left join tasks t         on t.id = d.task_id
  left join loops l         on l.id = coalesce(d.loop_id, t.loop_id)
  left join work_projects w on w.id = l.work_project_id
  left join people p        on p.id = coalesce(t.person_id, l.person_id)
  left join companies c     on c.id = coalesce(t.company_id, p.company_id)
  order by d.created_at desc
  limit 300`

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const TYPES: { t: ArtType | 'all'; label: string }[] = [
  { t: 'all', label: 'All' }, { t: 'doc', label: 'Documents' }, { t: 'sheet', label: 'Sheets' }, { t: 'deck', label: 'Decks' },
]

export function Docs() {
  const { version, view } = useNav()
  const rows = useSql<Doc>(rev(DOCS_SQL, version))
  const [q, setQ] = useState('')
  const [type, setType] = useState<ArtType | 'all'>('all')
  const needle = q.trim().toLowerCase()
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.items.length }
    for (const d of rows.items) c[artType(d)] = (c[artType(d)] ?? 0) + 1
    return c
  }, [rows.items])

  const shelves = useMemo(() => {
    const by = new Map<string, Doc[]>()
    for (const d of rows.items) {
      if (type !== 'all' && artType(d) !== type) continue
      if (needle && !`${d.title} ${d.bucket} ${d.body ?? ''}`.toLowerCase().includes(needle)) continue
      const name = d.bucket_kind === 'kind'
        ? (KIND_FOLDER[d.kind] ?? (d.kind ? titleCase(d.kind) : 'Everything else'))
        : d.bucket
      const key = name || 'Everything else'
      const list = by.get(key)
      if (list) list.push(d)
      else by.set(key, [d])
    }
    return [...by.entries()].sort((a, b) => {
      const fallback = (e: [string, Doc[]]) => (e[1][0].bucket_kind === 'kind' ? 1 : 0)
      return fallback(a) - fallback(b) || b[1].length - a[1].length
    })
  }, [rows.items, needle, type])

  // the type switch shows only once there is more than one kind of thing to tell apart
  const kinds = TYPES.filter((x) => x.t === 'all' || counts[x.t])

  return (
    <div className="page">
      <header className="page-h">
        <h1 className="display sm">Docs</h1>
        <span className="muted">{rows.items.length} prepared</span>
      </header>
      {(rows.items.length > 6 || kinds.length > 2) && (
        <div className="toolbar">
          {kinds.length > 2 && (
            <div className="seg sm" role="tablist" aria-label="Kind">
              {kinds.map((x) => (
                <button key={x.t} role="tab" aria-selected={type === x.t} className={type === x.t ? 'on' : ''} onClick={() => setType(x.t)}>
                  {x.label} <span>{counts[x.t]}</span>
                </button>
              ))}
            </div>
          )}
          {rows.items.length > 6 && (
            <label className="search"><Search size={14} /><input placeholder={`Search what ${tm()} prepared…`} value={q} onChange={(e) => setQ(e.target.value)} /></label>
          )}
        </div>
      )}
      {rows.isLoading ? <Loading rows={4} />
        : rows.items.length === 0 ? <Empty line={`${tm()} hasn’t prepared anything yet.`} />
          : shelves.length === 0 ? <Empty line="Nothing matches that." />
            : shelves.map(([name, docs]) => (
              <section key={name} className="shelf-sec">
                <div className="sec-h">{name} <span className="muted">{docs.length}</span></div>
                <div className="art-shelf">
                  {docs.map((d) => (
                    <ArtCard key={d.id} d={d} onOpen={() => view(d.id)}
                      sub={[d.bucket_kind === 'person' || d.bucket_kind === 'kind' ? '' : d.person, fmtDate(d.created_at)].filter(Boolean).join(' · ')} />
                  ))}
                </div>
              </section>
            ))}
    </div>
  )
}
