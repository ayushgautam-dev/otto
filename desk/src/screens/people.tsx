import { useMemo, useState } from 'react'
import { useCurrentUser } from 'lemma-sdk/react'
import { Search, ChevronRight } from 'lucide-react'
import { useSql, rev, client, ageLabel, type PersonRow } from '../lib'
import { Avatar, Logo, Empty, Loading } from '../ui'
import { useNav } from '../nav'

/* The address book: everyone you have dealt with, grouped the way an address book is —
   your team, each company with its people under it, then the people who belong to no
   company.

   It is one list, full width, not a grid of cards. Cards of different heights side by
   side (one company with a single person next to one with four) are what made this page
   look crowded; here every group is a header line and every person is a row of the same
   height in the same columns, so the eye runs straight down. */

const PERSONAL = /@(gmail|googlemail|yahoo|outlook|hotmail|icloud|me|proton|protonmail|live|rediffmail)\./i

interface P extends PersonRow { company_id?: string | null; domain?: string | null; last_contact_at?: string | null }
interface C { id: string; name: string; domain?: string | null; open_count: number; stage?: string | null; [k: string]: unknown }

/** People who belong to no company, by what they are to you. Only non-empty ones show. */
const LOOSE: { key: string; label: string }[] = [
  { key: 'candidate', label: 'Candidates' }, { key: 'investor', label: 'Investors' },
  { key: 'advisor', label: 'Advisors' }, { key: 'partner', label: 'Partners' },
  { key: 'individual', label: 'Individuals' },
]

function PersonLine({ p }: { p: P }) {
  const { open } = useNav()
  return (
    <button className="book-row" onClick={() => open({ type: 'person', id: p.id })}>
      <Avatar name={p.name} src={p.avatar_url} size="xs" />
      <span className="book-name">{p.name}</span>
      <span className="book-role">{p.role || p.email}</span>
      <span className="book-when">{p.last_contact_at ? ageLabel(p.last_contact_at) : ''}</span>
      <span className="book-n">{Number(p.open_count) > 0 && <b title="Open with them">{p.open_count}</b>}</span>
    </button>
  )
}

export function People() {
  const { version, open } = useNav()
  const { user } = useCurrentUser({ client })
  const myEmail = ((user as { email?: string } | undefined)?.email ?? '').toLowerCase()
  const myDomain = myEmail.split('@')[1] ?? ''
  const [q, setQ] = useState('')

  const people = useSql<P>(rev(
    `select p.id, p.name, p.email, p.role, p.avatar_url, p.relationship, p.company_id, p.last_contact_at,
            coalesce(c.name,'') as company, lower(c.domain) as domain,
            (select count(*) from loops l where l.person_id=p.id and l.status='open') as open_count
     from people p left join companies c on c.id = p.company_id
     order by p.name asc`, version))

  const companies = useSql<C>(rev(
    `select c.id, c.name, c.domain,
       (select count(*) from loops l join people p on p.id=l.person_id where p.company_id=c.id and l.status='open') as open_count,
       (select s.name from board_cards b join tracks t on t.id=b.track_id and coalesce(t.archived,false)=false
          left join stages s on s.id=b.stage_id where b.company_id=c.id limit 1) as stage
     from companies c
     order by c.name`, version))

  const needle = q.trim().toLowerCase()

  const { team, byCompany, loose, total } = useMemo(() => {
    const has = (s: string) => !needle || s.toLowerCase().includes(needle)
    // you are not one of your own contacts, and neither is a bot writing as you
    const humans = people.items.filter((p) =>
      (p.email ?? '').toLowerCase() !== myEmail && !/ via lemma$/i.test(p.name) && !/@ops\.lemma\.work$/i.test(p.email ?? ''))
    const bucket = (p: P) => {
      const dom = (p.email ?? '').split('@')[1]?.toLowerCase() ?? ''
      if (p.relationship === 'teammate' || (myDomain && dom === myDomain)) return 'team'
      if (p.company_id && !PERSONAL.test(p.email ?? '')) return 'company'
      return LOOSE.some((g) => g.key === p.relationship) ? String(p.relationship) : 'individual'
    }
    const matchP = (p: P) => has(`${p.name} ${p.email ?? ''} ${p.role ?? ''} ${p.company ?? ''}`)
    // the people you owe something first, then by name
    const order = (a: P, b: P) => Number(b.open_count) - Number(a.open_count) || a.name.localeCompare(b.name)

    const byCo = new Map<string, P[]>()
    for (const p of humans) if (bucket(p) === 'company' && p.company_id) {
      if (!byCo.has(p.company_id)) byCo.set(p.company_id, [])
      byCo.get(p.company_id)!.push(p)
    }
    const byCompany = companies.items
      .map((c) => {
        const all = byCo.get(c.id) ?? []
        // searching a company's name shows all its people; searching a person shows their company
        const named = has(`${c.name} ${c.domain ?? ''}`)
        const list = (named ? all : all.filter(matchP)).sort(order)
        return { c, people: list, show: named || list.length > 0 }
      })
      .filter((x) => x.show)
      .sort((a, b) => Number(b.c.open_count) - Number(a.c.open_count) || a.c.name.localeCompare(b.c.name))

    return {
      team: humans.filter((p) => bucket(p) === 'team' && matchP(p)).sort(order),
      byCompany,
      loose: LOOSE.map((g) => ({ ...g, people: humans.filter((p) => bucket(p) === g.key && matchP(p)).sort(order) }))
        .filter((g) => g.people.length > 0),
      total: humans.length,
    }
  }, [people.items, companies.items, needle, myEmail, myDomain])

  const loading = people.isLoading || companies.isLoading
  const nothing = !team.length && !byCompany.length && !loose.length

  return (
    <div className="page">
      <header className="page-h">
        <h1 className="display sm">People</h1>
        {!loading && <span className="muted">{total} people · {companies.items.length} companies</span>}
      </header>

      <div className="toolbar">
        <label className="search">
          <Search size={14} />
          <input placeholder="Search anyone, or any company…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>

      {loading ? <Loading rows={8} /> : nothing ? <Empty line="Nobody matches that." /> : (
        <div className="book">
          {team.length > 0 && (
            <section className="book-g">
              <div className="book-gh plain">
                <span className="book-gt">Your team</span>
                <span className="book-gc">{team.length}</span>
              </div>
              {team.map((p) => <PersonLine key={p.id} p={p} />)}
            </section>
          )}

          {byCompany.map(({ c, people: ps }) => (
            <section key={c.id} className="book-g">
              <button className="book-gh" onClick={() => open({ type: 'company', id: c.id })}>
                <Logo name={c.name} domain={c.domain} size="sm" />
                <span className="book-gt">{c.name}</span>
                {c.stage && <span className="book-stage">{c.stage}</span>}
                <span className="grow" />
                {Number(c.open_count) > 0 && <span className="book-n"><b title="Open with them">{c.open_count}</b></span>}
                <ChevronRight size={15} className="book-go" />
              </button>
              {ps.map((p) => <PersonLine key={p.id} p={p} />)}
            </section>
          ))}

          {loose.map((g) => (
            <section key={g.key} className="book-g">
              <div className="book-gh plain">
                <span className="book-gt">{g.label}</span>
                <span className="book-gc">{g.people.length}</span>
              </div>
              {g.people.map((p) => <PersonLine key={p.id} p={p} />)}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
