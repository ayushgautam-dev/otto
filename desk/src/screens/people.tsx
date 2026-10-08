import { useMemo, useState } from 'react'
import { useCurrentUser } from 'lemma-sdk/react'
import { Search, ArrowDown, ArrowUp } from 'lucide-react'
import { useSql, rev, client, ageLabel, type PersonRow } from '../lib'
import { Empty, Loading } from '../ui'
import { useNav } from '../nav'

/* The address book: everyone you have dealt with, as a plain table.

   What is *open* with people lives on Today. This page is who you know, and it is read by
   scanning, so it is text in columns: no avatars, no logos, nothing competing for the eye.
   One row per person (or per company, on the other side of the switch); a click opens
   them. Search reaches every column, and any column can be sorted. */

const PERSONAL = /@(gmail|googlemail|yahoo|outlook|hotmail|icloud|me|proton|protonmail|live|rediffmail)\./i

interface P extends PersonRow { company_id?: string | null; domain?: string | null; last_contact_at?: string | null }
interface C {
  id: string; name: string; domain?: string | null; open_count: number; people_count: number
  stage?: string | null; board?: string | null; last_contact_at?: string | null; [k: string]: unknown
}

const KIND: Record<string, string> = {
  teammate: 'Team', candidate: 'Candidate', prospect: 'Prospect', investor: 'Investor',
  vendor: 'Vendor', partner: 'Partner', advisor: 'Advisor',
}

type Dir = 'asc' | 'desc'
interface Col<T> { key: string; label: string; get: (r: T) => string | number; num?: boolean; width?: string }

/** A sortable column head. Text sorts A to Z first; numbers and dates, biggest first. */
function Head<T>({ cols, sort, setSort }: { cols: Col<T>[]; sort: { key: string; dir: Dir }; setSort: (s: { key: string; dir: Dir }) => void }) {
  return (
    <thead>
      <tr>
        {cols.map((c) => {
          const on = sort.key === c.key
          return (
            <th key={c.key} className={c.num ? 'num' : ''} style={c.width ? { width: c.width } : undefined}
              aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button onClick={() => setSort({ key: c.key, dir: on ? (sort.dir === 'asc' ? 'desc' : 'asc') : c.num ? 'desc' : 'asc' })}>
                {c.label}
                {on && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
            </th>
          )
        })}
      </tr>
    </thead>
  )
}

function sorted<T>(rows: T[], cols: Col<T>[], sort: { key: string; dir: Dir }): T[] {
  const col = cols.find((c) => c.key === sort.key) ?? cols[0]
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = col.get(a), y = col.get(b)
    // blanks always sink to the bottom, whichever way the column is sorted
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign
  })
}

const when = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0)

export function People() {
  const { version, open } = useNav()
  const { user } = useCurrentUser({ client })
  const myEmail = ((user as { email?: string } | undefined)?.email ?? '').toLowerCase()
  const myDomain = myEmail.split('@')[1] ?? ''
  const [q, setQ] = useState('')
  const [view, setView] = useState<'people' | 'companies'>('people')
  const [pSort, setPSort] = useState<{ key: string; dir: Dir }>({ key: 'open', dir: 'desc' })
  const [cSort, setCSort] = useState<{ key: string; dir: Dir }>({ key: 'open', dir: 'desc' })

  const people = useSql<P>(rev(
    `select p.id, p.name, p.email, p.role, p.relationship, p.company_id, p.last_contact_at,
            coalesce(c.name,'') as company, lower(c.domain) as domain,
            (select count(*) from loops l where l.person_id=p.id and l.status='open') as open_count
     from people p left join companies c on c.id = p.company_id
     order by p.name asc`, version))

  const companies = useSql<C>(rev(
    `select c.id, c.name, c.domain,
       (select count(*) from loops l join people p on p.id=l.person_id where p.company_id=c.id and l.status='open') as open_count,
       (select count(*) from people p where p.company_id=c.id) as people_count,
       (select max(p.last_contact_at) from people p where p.company_id=c.id) as last_contact_at,
       sb.stage, sb.board
     from companies c
     left join lateral (
       select s.name as stage, t.name as board
       from board_cards b join tracks t on t.id=b.track_id and coalesce(t.archived,false)=false
       left join stages s on s.id=b.stage_id
       where b.company_id=c.id limit 1) sb on true
     order by c.name`, version))

  const kindOf = (p: P) => {
    const dom = (p.email ?? '').split('@')[1]?.toLowerCase() ?? ''
    if (p.relationship === 'teammate' || (myDomain && dom === myDomain)) return 'Team'
    return KIND[p.relationship ?? ''] ?? ''
  }

  const pCols: Col<P>[] = [
    { key: 'name', label: 'Name', get: (p) => p.name, width: '22%' },
    // a personal address is not a company, whatever the domain says
    { key: 'company', label: 'Company', get: (p) => (PERSONAL.test(p.email ?? '') ? '' : p.company ?? ''), width: '20%' },
    { key: 'role', label: 'Role', get: (p) => p.role ?? '' },
    { key: 'kind', label: 'Kind', get: kindOf, width: '104px' },
    { key: 'last', label: 'Last spoke', get: (p) => when(p.last_contact_at) || '', num: true, width: '104px' },
    { key: 'open', label: 'Open', get: (p) => Number(p.open_count) || 0, num: true, width: '64px' },
  ]
  const cCols: Col<C>[] = [
    { key: 'name', label: 'Company', get: (c) => c.name },
    { key: 'stage', label: 'Where it stands', get: (c) => c.stage ?? '' },
    { key: 'people', label: 'People', get: (c) => Number(c.people_count) || 0, num: true, width: '80px' },
    { key: 'last', label: 'Last spoke', get: (c) => when(c.last_contact_at) || '', num: true, width: '104px' },
    { key: 'open', label: 'Open', get: (c) => Number(c.open_count) || 0, num: true, width: '64px' },
  ]

  const needle = q.trim().toLowerCase()
  const { pRows, cRows, total } = useMemo(() => {
    // you are not one of your own contacts, and neither is a bot writing as you
    const humans = people.items.filter((p) =>
      (p.email ?? '').toLowerCase() !== myEmail && !/ via lemma$/i.test(p.name) && !/@ops\.lemma\.work$/i.test(p.email ?? ''))
    const has = (s: string) => !needle || s.toLowerCase().includes(needle)
    return {
      total: humans.length,
      pRows: sorted(humans.filter((p) => has(`${p.name} ${p.email ?? ''} ${p.role ?? ''} ${p.company ?? ''} ${kindOf(p)}`)), pCols, pSort),
      cRows: sorted(companies.items.filter((c) => has(`${c.name} ${c.domain ?? ''} ${c.stage ?? ''}`)), cCols, cSort),
    }
  }, [people.items, companies.items, needle, myEmail, myDomain, pSort, cSort])

  const loading = people.isLoading || companies.isLoading

  return (
    <div className="page">
      <header className="page-h">
        <h1 className="display sm">People</h1>
        <div className="seg">
          <button className={view === 'people' ? 'on' : ''} onClick={() => setView('people')}>People <span>{loading ? '' : total}</span></button>
          <button className={view === 'companies' ? 'on' : ''} onClick={() => setView('companies')}>Companies <span>{loading ? '' : companies.items.length}</span></button>
        </div>
      </header>

      <div className="toolbar">
        <label className="search">
          <Search size={14} />
          <input placeholder={view === 'people' ? 'Search by name, company or role…' : 'Search companies…'} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      {loading ? <Loading rows={8} /> : view === 'people' ? (
        pRows.length === 0 ? <Empty line="Nobody matches that." /> : (
          <div className="book">
            <table className="book-t">
              <Head cols={pCols} sort={pSort} setSort={setPSort} />
              <tbody>
                {pRows.map((p) => {
                  const company = PERSONAL.test(p.email ?? '') ? '' : p.company
                  return (
                    <tr key={p.id} tabIndex={0} onClick={() => open({ type: 'person', id: p.id })}
                      onKeyDown={(e) => { if (e.key === 'Enter') open({ type: 'person', id: p.id }) }}>
                      <td className="book-n">{p.name}</td>
                      <td>
                        {company && p.company_id
                          ? <button className="book-link" onClick={(e) => { e.stopPropagation(); open({ type: 'company', id: p.company_id! }) }}>{company}</button>
                          : null}
                      </td>
                      <td className="book-dim" title={p.role ?? undefined}>{p.role}</td>
                      <td className="book-dim">{kindOf(p)}</td>
                      <td className="num book-dim">{p.last_contact_at ? ageLabel(p.last_contact_at) : ''}</td>
                      <td className="num">{Number(p.open_count) > 0 ? <b className="book-open">{p.open_count}</b> : ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        cRows.length === 0 ? <Empty line="No company matches that." /> : (
          <div className="book">
            <table className="book-t">
              <Head cols={cCols} sort={cSort} setSort={setCSort} />
              <tbody>
                {cRows.map((c) => (
                  <tr key={c.id} tabIndex={0} onClick={() => open({ type: 'company', id: c.id })}
                    onKeyDown={(e) => { if (e.key === 'Enter') open({ type: 'company', id: c.id }) }}>
                    <td className="book-n">{c.name}{c.domain && <span className="book-dom">{c.domain}</span>}</td>
                    <td className="book-dim">{c.stage}</td>
                    <td className="num book-dim">{Number(c.people_count) || ''}</td>
                    <td className="num book-dim">{c.last_contact_at ? ageLabel(c.last_contact_at) : ''}</td>
                    <td className="num">{Number(c.open_count) > 0 ? <b className="book-open">{c.open_count}</b> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
