import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  X, FileText, Table2, Presentation, Download, ExternalLink, Copy, Check, ChevronLeft, ChevronRight,
  Maximize2, MoreHorizontal,
} from 'lucide-react'
import { client, useSql, rev, lit, records, runFn, fmtDate } from './lib'
import { Markdown, Orb, BlankCtx, BLANK, countBlanks, useToast, Loading, Empty } from './ui'
import { useNav } from './nav'
import { DocChat } from './lem'
import { tm } from './teammate'
import { readText, BUSINESS, parse as parseWiki } from './wiki'

/* What the teammate prepares that is a thing, not a message: a document, a sheet, a deck.
   Each is drawn as itself — a page with the person's own letterhead, a grid with tabs,
   a set of slides — small on a card where the work is, and full size in the viewer, with
   the teammate one question away. All three are a `deliverables` row: `body` is markdown
   (a sheet's tabs are `## Tab` headings over a table; a deck's slides are split by `---`),
   and `format` says how it goes out. */

export type ArtType = 'doc' | 'sheet' | 'deck'

export interface ArtRow {
  id: string
  title: string
  body?: string | null
  kind?: string | null
  format?: string | null
  status?: string | null
  doc_url?: string | null
  file_path?: string | null
  created_at?: string | null
  loop_id?: string | null
  person?: string | null
  company?: string | null
  [k: string]: unknown
}

export const ART_SELECT = `
  select d.id, d.title, d.body, d.kind, d.format, d.status, d.doc_url, d.file_path, d.created_at, d.loop_id,
         coalesce(p.name,'') as person, coalesce(c.name,'') as company
  from deliverables d
  left join loops l on l.id = d.loop_id
  left join people p on p.id = l.person_id
  left join companies c on c.id = p.company_id`

export function artType(d: Pick<ArtRow, 'kind' | 'format'>): ArtType {
  const f = String(d.format ?? '').toLowerCase()
  if (String(d.kind ?? '').toLowerCase() === 'deck' || /^(deck|slides|gslides|pptx)$/.test(f)) return 'deck'
  if (/^(sheet|gsheet|xlsx|csv)$/.test(f)) return 'sheet'
  return 'doc'
}

/** Prepared to go to someone, as opposed to research written for the person themselves. */
export const isOutgoing = (d: Pick<ArtRow, 'kind'>) => !['research', 'analysis'].includes(String(d.kind ?? '').toLowerCase())

const FORMAT: Record<string, string> = {
  pdf: 'PDF', gdoc: 'Google Doc', docx: 'Word', md: 'Markdown', markdown: 'Markdown',
  gsheet: 'Google Sheet', xlsx: 'Excel', csv: 'CSV', gslides: 'Google Slides', pptx: 'PowerPoint',
}
export function formatLabel(d: Pick<ArtRow, 'kind' | 'format'>): string {
  const t = artType(d)
  return FORMAT[String(d.format ?? '').toLowerCase()] ?? (t === 'sheet' ? 'Sheet' : t === 'deck' ? 'Slides' : '')
}

/** What the thing is, in the words on its first line: an invoice, an offer letter… */
export function kindLabel(d: Pick<ArtRow, 'kind' | 'format' | 'title'>): string {
  const k = String(d.kind ?? '').toLowerCase()
  if (k === 'research') return 'Research'
  if (k === 'analysis') return 'Analysis'
  const t = artType(d)
  const title = d.title || ''
  const words: [RegExp, string][] = [
    [/invoice/i, 'Invoice'], [/offer letter/i, 'Offer letter'], [/letter of intent|\bLOI\b/i, 'Letter of intent'],
    [/proposal/i, 'Proposal'], [/minutes/i, 'Minutes'], [/agreement|contract|\bNDA\b/i, 'Agreement'],
    [/job description|\bJD\b/i, 'Job description'], [/brief/i, 'Brief'], [/requirements|spec/i, 'Specification'],
    [/pricing|quote|estimate/i, 'Pricing'], [/plan\b/i, 'Plan'],
  ]
  for (const [re, w] of words) if (re.test(title)) return w
  return t === 'sheet' ? 'Sheet' : t === 'deck' ? 'Deck' : 'Document'
}

const TypeIcon = ({ t, size = 13 }: { t: ArtType; size?: number }) =>
  t === 'sheet' ? <Table2 size={size} /> : t === 'deck' ? <Presentation size={size} /> : <FileText size={size} />

/* ---------------- the person's letterhead ---------------- */

export interface Letterhead { name: string; lines: string[] }

let businessCache: Promise<Letterhead | null> | null = null

/** From `/me/business.md` ("My details"): the legal name, the address and the contact line
 *  printed on documents. Nothing is guessed: no file, no letterhead. */
function loadLetterhead(): Promise<Letterhead | null> {
  businessCache ??= readText(BUSINESS).then((md) => {
    if (!md) return null
    const mine = parseWiki(md).sections.find((s) => /my details/i.test(s.heading))
    if (!mine) return null
    const field = (re: RegExp) => {
      for (const raw of mine.body.split('\n')) {
        const m = /^\s*[-*]\s*([^:]+):\s*(.*)$/.exec(raw)
        if (!m || !re.test(m[1])) continue
        const v = m[2].replace(/\*?\([^)]*\)\*?/g, '').replace(/[*_`]/g, '').split(/\s+[—–]\s+|;\s+/)[0]
          .replace(/,\s+[a-z].*$/, '').trim()
        if (v && !/^\[?(…|\.\.\.)/.test(v)) return v
      }
      return ''
    }
    const name = field(/legal name|business name|company/i)
    if (!name) return null
    const lines = [field(/^address/i), field(/email|phone/i)].filter(Boolean)
    return { name, lines }
  }).catch(() => null)
  return businessCache
}

export function useLetterhead(): Letterhead | null | undefined {
  const [lh, setLh] = useState<Letterhead | null | undefined>(undefined)
  useEffect(() => { let on = true; void loadLetterhead().then((v) => { if (on) setLh(v) }); return () => { on = false } }, [])
  return lh
}

/* ---------------- a document: a page ---------------- */

/** A document that opens with its own title, or with just what it is ("# Invoice"), would
 *  say it twice under the page's own heading. */
function bodyOf(d: ArtRow): string {
  return String(d.body ?? '').replace(/^\s*#\s+(.+)\n+/, (m, h: string) => {
    const said = h.trim().toLowerCase()
    return said === (d.title || '').trim().toLowerCase() || said === kindLabel(d).toLowerCase() ? '' : m
  })
}

const initials = (s: string) => s.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export function DocPage({ d, lh, short }: { d: ArtRow; lh: Letterhead | null | undefined; short?: boolean }) {
  const body = bodyOf(d)
  const outgoing = isOutgoing(d)
  // a document that already carries its own heading (the precedent's) keeps it, alone
  const head = outgoing && lh && !body.slice(0, 400).toLowerCase().includes(lh.name.toLowerCase()) ? lh : null
  const who = [d.person, d.company].filter(Boolean).join(', ')
  return (
    <article className="dpage" data-blanks="">
      {head && (
        <header className="dp-lh">
          <div className="dp-name"><span className="dp-mark">{initials(head.name)}</span>{head.name}</div>
          {head.lines.length > 0 && <div className="dp-addr">{head.lines.join('\n')}</div>}
        </header>
      )}
      <div className="dp-eyebrow">{kindLabel(d)}</div>
      <h1 className="dp-title">{d.title}</h1>
      <div className="dp-meta">
        {who && <div><small>{outgoing ? 'For' : 'About'}</small>{who}</div>}
        <div><small>Date</small>{fmtDate(d.created_at) || '—'}</div>
        {!outgoing && <div><small>Prepared by</small>{tm()}, for you</div>}
      </div>
      <div className="dp-body"><Markdown text={short ? body.slice(0, 1400) : body} breaks /></div>
    </article>
  )
}

/* ---------------- a sheet: tabs of tables ---------------- */

interface Tab { name: string; rows: string[][] }

export function parseSheet(md: string, fallback: string): Tab[] {
  const tabs: Tab[] = []
  let name = fallback
  let cur: Tab | null = null
  for (const raw of (md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    const h = /^#{1,3}\s+(.+)$/.exec(line)
    if (h) { name = h[1].trim(); cur = null; continue }
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, '$1'))
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      if (!cur) { cur = { name: name || `Sheet ${tabs.length + 1}`, rows: [] }; tabs.push(cur) }
      cur.rows.push(cells)
    } else if (line) cur = null
  }
  return tabs
}

const NUM = /^[-+(]?\s?[$€£₹¥]?\s?\d[\d,]*(\.\d+)?\)?\s?%?$/
const isNum = (v: string) => NUM.test(v.trim())
const isTotal = (r: string[]) => /^(total|subtotal|grand total|net|balance)\b/i.test((r[0] || '').trim())
const colName = (i: number): string => (i >= 26 ? colName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26))

function SheetGrid({ tab, small, onPick, picked }: {
  tab: Tab; small?: boolean; picked?: [number, number] | null; onPick?: (r: number, c: number) => void
}) {
  const width = Math.max(...tab.rows.map((r) => r.length), 1)
  const rows = small ? tab.rows.slice(0, 7) : tab.rows
  const cols = small ? Math.min(width, 4) : width
  return (
    <table className={`sh${small ? ' sm' : ''}`}>
      <thead><tr><th className="rn" />{Array.from({ length: cols }, (_, i) => <th key={i}>{colName(i)}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className={ri === 0 ? 'hd' : isTotal(r) ? 'total' : ''}>
            <td className="rn">{ri + 1}</td>
            {Array.from({ length: cols }, (_, ci) => {
              const v = r[ci] ?? ''
              const on = picked && picked[0] === ri && picked[1] === ci
              return (
                <td key={ci} className={`${ri > 0 && isNum(v) ? 'num' : ''}${on ? ' on' : ''}`}
                  onClick={onPick ? () => onPick(ri, ci) : undefined}>
                  {v.includes('[') ? <Markdown text={v} /> : v}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SheetView({ d }: { d: ArtRow }) {
  const tabs = useMemo(() => parseSheet(String(d.body ?? ''), d.title), [d.body, d.title])
  const [at, setAt] = useState(0)
  const [picked, setPicked] = useState<[number, number] | null>(null)
  const tab = tabs[Math.min(at, tabs.length - 1)]
  if (!tab) return <div className="dpage"><div className="dp-body"><Markdown text={String(d.body ?? '')} /></div></div>
  const cell = picked ? `${colName(picked[1])}${picked[0] + 1}` : ''
  return (
    <div className="sheet" data-blanks="">
      <div className="sh-top">
        <span className="sh-ic"><Table2 size={13} /></span>
        <b>{d.title}</b>
        <span className="grow" />
        <span className="sh-ref">{picked ? <>{cell} <span>{tab.rows[picked[0]]?.[picked[1]] ?? ''}</span></> : `${tab.rows.length} rows`}</span>
      </div>
      <div className="sh-scroll"><SheetGrid tab={tab} picked={picked} onPick={(r, c) => setPicked([r, c])} /></div>
      {tabs.length > 1 && (
        <div className="sh-tabs" role="tablist">
          {tabs.map((t, i) => (
            <button key={i} role="tab" aria-selected={i === at} className={i === at ? 'on' : ''}
              onClick={() => { setAt(i); setPicked(null) }}>{t.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- a deck: slides ---------------- */

interface Slide { title: string; body: string; cards: { label: string; text: string }[] | null }

export function parseDeck(md: string): Slide[] {
  const text = (md || '').replace(/\r/g, '')
  let chunks = text.split(/\n\s*(?:-{3,}|\*{3,})\s*\n/)
  if (chunks.length < 2) chunks = text.split(/\n(?=#{1,2}\s)/)
  return chunks.map((c) => c.trim()).filter(Boolean).map((c) => {
    const lines = c.split('\n')
    const hi = lines.findIndex((l) => /^#{1,4}\s+/.test(l.trim()))
    const title = hi >= 0 ? lines[hi].trim().replace(/^#{1,4}\s+/, '') : ''
    const body = lines.filter((_, i) => i !== hi).join('\n').trim()
    // a slide that is only a short list of two to four points is drawn as cards
    const items = body.split('\n').filter((l) => l.trim())
    const listy = items.length >= 2 && items.length <= 4 && items.every((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l))
    const cards = listy ? items.map((l) => {
      const t = l.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
      const m = /^\*\*(.+?)\*\*\s*[—–:-]?\s*(.*)$/.exec(t) ?? /^([^:—–]{2,32})\s*[:—–]\s+(.*)$/.exec(t)
      return m ? { label: m[1], text: m[2] } : { label: '', text: t }
    }) : null
    return { title, body, cards }
  })
}

function SlideFace({ s, i, n, eyebrow }: { s: Slide; i: number; n: number; eyebrow: string }) {
  const first = i === 0
  return (
    <div className="slide">
      <div className={`sl${first ? ' first' : ''}`}>
        <div className="sl-k">{first ? eyebrow : `${String(i + 1).padStart(2, '0')} · ${eyebrow}`}</div>
        {s.title && <div className="sl-h">{s.title}</div>}
        {s.cards ? (
          <div className="sl-cards" style={{ ['--n' as string]: s.cards.length }}>
            {s.cards.map((c, k) => (
              <div key={k} className="sl-card">
                <b>{c.label || String(k + 1).padStart(2, '0')}</b>
                <span>{c.text}</span>
              </div>
            ))}
          </div>
        ) : s.body ? <div className="sl-b"><Markdown text={s.body} /></div> : null}
        {!first && <span className="sl-num">{i + 1} / {n}</span>}
      </div>
    </div>
  )
}

function DeckView({ d }: { d: ArtRow }) {
  const slides = useMemo(() => parseDeck(String(d.body ?? '')), [d.body])
  const [at, setAt] = useState(0)
  const stage = useRef<HTMLDivElement>(null)
  const n = slides.length
  const go = (i: number) => setAt(Math.max(0, Math.min(n - 1, i)))
  if (!n) return <Empty line="This deck has no slides yet." />
  const eyebrow = [d.company, kindLabel(d)].filter(Boolean).join(' · ')
  return (
    <div className="deck">
      <div className="deck-thumbs" aria-label="Slides">
        {slides.map((s, i) => (
          <button key={i} className={`deck-th${i === at ? ' on' : ''}`} onClick={() => go(i)} aria-label={`Slide ${i + 1}`}>
            <SlideFace s={s} i={i} n={n} eyebrow={eyebrow} />
          </button>
        ))}
      </div>
      <div className="deck-main">
        <div ref={stage} className="deck-stage" tabIndex={0} data-blanks=""
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(at + 1) }
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(at - 1) }
          }}>
          <SlideFace s={slides[at]} i={at} n={n} eyebrow={eyebrow} />
        </div>
        <div className="deck-bar">
          <button className="icon-btn" onClick={() => go(at - 1)} disabled={at === 0} aria-label="Previous slide"><ChevronLeft size={16} /></button>
          <span className="muted">{at + 1} / {n}</span>
          <button className="icon-btn" onClick={() => go(at + 1)} disabled={at === n - 1} aria-label="Next slide"><ChevronRight size={16} /></button>
          <span className="grow" />
          <button className="btn line sm" onClick={() => { stage.current?.focus(); void stage.current?.requestFullscreen?.() }}>
            <Maximize2 size={13} /> Present
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- the thing itself, at any size ---------------- */

export function ArtBody({ d }: { d: ArtRow }) {
  const lh = useLetterhead()
  const t = artType(d)
  if (t === 'sheet') return <SheetView d={d} />
  if (t === 'deck') return <DeckView d={d} />
  return <DocPage d={d} lh={lh} />
}

/** The first page, the first rows, the first slide — small, as on a desk. */
export function Thumb({ d }: { d: ArtRow }) {
  const lh = useLetterhead()
  const t = artType(d)
  if (t === 'sheet') {
    const tab = parseSheet(String(d.body ?? '').slice(0, 2400), d.title)[0]
    return <div className="th th-sheet">{tab ? <SheetGrid tab={tab} small /> : null}</div>
  }
  if (t === 'deck') {
    const s = parseDeck(String(d.body ?? '').slice(0, 2400))
    return <div className="th th-deck">{s[0] ? <SlideFace s={s[0]} i={0} n={s.length} eyebrow={kindLabel(d)} /> : null}</div>
  }
  return <div className="th th-doc"><div className="th-scale"><DocPage d={d} lh={lh} short /></div></div>
}

/* ---------------- a card, where the work is ---------------- */

export function ArtCard({ d, onOpen, attach, sub }: {
  d: ArtRow; onOpen: () => void
  /** a quiet line under the title (whom it was for, when) */
  sub?: string
  /** in the reply or not — only when there is a reply to carry it */
  attach?: { on: boolean; toggle: () => void } | null
}) {
  const t = artType(d)
  const blanks = d.blanks != null ? Number(d.blanks) : countBlanks(d.body)
  const fmt = formatLabel(d)
  return (
    <div className="art-card">
      <button className="art-thumb" onClick={onOpen} aria-label={`Open ${d.title}`}><Thumb d={d} /></button>
      <div className="art-info">
        <div className="art-k"><TypeIcon t={t} /> {kindLabel(d)}{fmt ? ` · ${fmt}` : ''}</div>
        <div className="art-t">{d.title}</div>
        {sub && <div className="art-sub">{sub}</div>}
        <div className="art-row">
          {d.status === 'used' ? <span className="tag slate">Sent</span>
            : d.status === 'discarded' ? <span className="tag slate">Discarded</span> : blanks > 0
            ? <span className="tag gold">{blanks === 1 ? '1 blank to fill' : `${blanks} blanks to fill`}</span>
            : isOutgoing(d) ? <span className="tag moss">Ready</span> : <span className="tag slate">For you</span>}
          <span className="grow" />
          <button className="btn ghost sm" onClick={onOpen}>Open</button>
          {attach && (
            <button className={`btn line sm art-att${attach.on ? ' on' : ''}`} onClick={attach.toggle} aria-pressed={attach.on}>
              {attach.on ? <><Check size={12} /> In the reply</> : 'Add to reply'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------------- getting it out ---------------- */

const safeName = (s: string) => (s || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document'

function save(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

const FONTS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap'

/** Print the thing on its own, the way it is drawn here: "Save as PDF" in the print dialog
 *  gives the file. The window's title becomes the file's name. */
function printPage(title: string, inner: string, pageCss: string): boolean {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="${FONTS}"><style>${PAGE_CSS}
html,body{margin:0;background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
${pageCss}</style></head><body>${inner}</body></html>`)
  w.document.close()
  const go = () => { w.focus(); w.print() }
  void (w.document.fonts?.ready ?? Promise.resolve()).then(() => window.setTimeout(go, 250))
  return true
}

const DOC_PRINT = `@page{size:A4;margin:0}.dpage{box-shadow:none!important;border-radius:0!important;max-width:none!important;min-height:auto}`
const DECK_PRINT = `@page{size:13.333in 7.5in;margin:0}.slide{width:13.333in!important;height:7.5in;aspect-ratio:auto!important;border-radius:0!important;break-after:page}`

function wordHtml(d: ArtRow, lh: Letterhead | null | undefined) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${d.title.replace(/</g, '&lt;')}</title><style>${PAGE_CSS}
body{font-family:Calibri,Arial,sans-serif;font-size:11pt}.dp-title{font-family:Georgia,serif}</style></head>
<body>${renderToStaticMarkup(<DocPage d={d} lh={lh} />)}</body></html>`
}

/* A real .xlsx, written here: one worksheet per tab, numbers as numbers. The workbook is a
   zip of a few XML parts; stored without compression, which every spreadsheet app reads. */
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(b: Uint8Array) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

function zip(files: { name: string; text: string }[]): Blob {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const data = enc.encode(f.text)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true)
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, data)
    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true)
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true)
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true)
    central.push(new Uint8Array(cen.buffer), name)
    offset += 30 + name.length + data.length
  }
  const size = central.reduce((s, p) => s + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
  end.setUint32(12, size, true); end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function xlsx(tabs: Tab[]): Blob {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const names = tabs.map((t, i) => (t.name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet ${i + 1}`))
  const sheet = (t: Tab) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${
    t.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`
      const n = v.replace(/[$€£₹¥,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
      return ri > 0 && /^-?\d+(\.\d+)?$/.test(n)
        ? `<c r="${ref}"><v>${n}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`
    }).join('')}</row>`).join('')}</sheetData></worksheet>`
  return zip([
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${tabs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${R}"><sheets>${names.map((n, i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    ...tabs.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheet(t) })),
  ])
}

/** A document that was rendered to a file (an invoice as a PDF) opens as that file. */
async function openFile(path: string, toast: (m: string) => void) {
  const win = window.open('', '_blank')
  try {
    const blob = await (client as unknown as { files: { download: (p: string) => Promise<Blob> } }).files.download(path)
    const url = URL.createObjectURL(blob)
    if (win) win.location.href = url
    else save(path.split('/').pop() || 'document', blob)
  } catch {
    win?.close()
    toast('Could not open the file')
  }
}

function Tools({ d }: { d: ArtRow }) {
  const toast = useToast()
  const { bump } = useNav()
  const lh = useLetterhead()
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(d.doc_url ?? '')
  const t = artType(d)
  useEffect(() => { setUrl(d.doc_url ?? '') }, [d.id, d.doc_url])

  async function toGoogle() {
    if (url) { window.open(url, '_blank', 'noopener'); return }
    const win = window.open('', '_blank')
    setBusy(true)
    try {
      const out = await runFn<{ saved?: boolean; url?: string; needs_connect?: boolean; error?: string }>(
        'save_google_doc', { title: d.title, markdown: d.body ?? '' })
      if (out?.saved && out.url) {
        setUrl(out.url)
        await records.update('deliverables', d.id, { doc_url: out.url })
        bump()
        if (win) win.location.href = out.url
        return
      }
      if (out?.needs_connect) {
        const c = await runFn<{ authorization_url?: string }>('connect_source', { app: 'google_docs' })
        if (c?.authorization_url && win) { win.location.href = c.authorization_url; toast('Connect Google Docs, then press it again') }
        else { win?.close(); toast('Google Docs is connected — press it again') }
        return
      }
      win?.close()
      toast(out?.error || 'Could not create the Google Doc')
    } catch (e) {
      win?.close()
      toast((e as Error)?.message || 'Could not create the Google Doc')
    } finally { setBusy(false) }
  }

  const pdf = () => {
    const inner = t === 'deck'
      ? parseDeck(String(d.body ?? '')).map((s, i, all) => renderToStaticMarkup(
        <SlideFace s={s} i={i} n={all.length} eyebrow={[d.company, kindLabel(d)].filter(Boolean).join(' · ')} />)).join('')
      : renderToStaticMarkup(<DocPage d={d} lh={lh} />)
    if (!printPage(safeName(d.title), inner, t === 'deck' ? DECK_PRINT : DOC_PRINT)) toast('Allow pop-ups to save the PDF')
  }
  const excel = () => save(`${safeName(d.title)}.xlsx`, xlsx(parseSheet(String(d.body ?? ''), d.title)))
  const csv = () => {
    const tab = parseSheet(String(d.body ?? ''), d.title)[0]
    const text = (tab?.rows ?? []).map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')
    save(`${safeName(d.title)}.csv`, new Blob([text], { type: 'text/csv' }))
  }
  const word = () => save(`${safeName(d.title)}.doc`, new Blob([wordHtml(d, lh)], { type: 'application/msword' }))
  const copy = () => { void navigator.clipboard.writeText(d.body ?? ''); toast('Copied') }
  const file = typeof d.file_path === 'string' && /\.pdf$/i.test(d.file_path) ? d.file_path : ''

  /* One way out in plain sight — the one most people want for this kind of thing — and the
     rest in a short menu, so the bar stays quiet. */
  const primary = t === 'sheet' ? { label: 'Download Excel', run: excel }
    : file ? { label: 'Open the PDF', run: () => void openFile(file, toast) }
      : { label: 'Download PDF', run: pdf }
  const more: { label: string; icon: ReactNode; run: () => void }[] = [
    ...(t === 'doc' && file ? [{ label: 'Save this page as a PDF', icon: <Download size={14} />, run: pdf }] : []),
    ...(t === 'doc' ? [{ label: busy ? 'Opening…' : url ? 'Open in Google Docs' : 'Make a Google Doc', icon: <ExternalLink size={14} />, run: () => void toGoogle() }] : []),
    ...(t === 'doc' ? [{ label: 'Download for Word', icon: <FileText size={14} />, run: word }] : []),
    ...(t === 'sheet' ? [{ label: 'Download CSV', icon: <Table2 size={14} />, run: csv }] : []),
    { label: 'Copy the text', icon: <Copy size={14} />, run: copy },
  ]
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', out)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', out); window.removeEventListener('keydown', esc, true) }
  }, [open])

  return (
    <div className="vw-tools" ref={box}>
      <button className="btn line sm" onClick={primary.run}><Download size={13} /> {primary.label}</button>
      <button className={`icon-btn${open ? ' on' : ''}`} aria-label="More ways to get it" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="vw-menu" role="menu">
          {more.map((m) => (
            <button key={m.label} role="menuitem" disabled={busy && m.label === 'Opening…'} onClick={() => { setOpen(false); m.run() }}>
              {m.icon}<span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- the viewer ---------------- */

const ASKS: Record<ArtType, string[]> = {
  doc: ['Make it shorter', 'Fill the blanks you can', 'Make it more formal'],
  sheet: ['Add a totals row', 'Add a cheaper option', 'Split it by month'],
  deck: ['Cut it to fewer slides', 'Add a slide on risks', 'Use simpler words'],
}

function AskPanel({ d }: { d: ArtRow }) {
  const what = kindLabel(d).toLowerCase()
  const [quote, setQuote] = useState<string | null>(null)
  // whatever is selected on the page last is what the question is about
  useEffect(() => {
    const on = () => {
      const sel = window.getSelection()
      const s = (sel?.toString() ?? '').replace(/\s+/g, ' ').trim()
      if (s.length < 2) return
      const node = sel?.anchorNode
      const el = node instanceof Element ? node : node?.parentElement
      if (!el?.closest('.vw-stage')) return
      setQuote(s.length > 600 ? `${s.slice(0, 600)}…` : s)
    }
    document.addEventListener('mouseup', on)
    return () => document.removeEventListener('mouseup', on)
  }, [])
  return (
    <aside className="vw-ask" aria-label={`Ask ${tm()}`}>
      <div className="vw-ask-h">
        <Orb size={22} />
        <div><b>Ask {tm()}</b><small>about this {what}</small></div>
      </div>
      <DocChat id={d.id} title={d.title} what={what} quote={quote} onClearQuote={() => setQuote(null)} starters={ASKS[artType(d)]} />
    </aside>
  )
}

export function Viewer() {
  const { viewing, view, closeView, version, bump } = useNav()
  const toast = useToast()
  const ids = viewing?.group ?? []
  const q = useSql<ArtRow>(rev(ids.length ? `${ART_SELECT} where d.id in (${ids.map(lit).join(',')})` : null, version))
  useEffect(() => {
    if (!viewing) return
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea')) return
      closeView()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [viewing, closeView])
  if (!viewing) return null
  const rows = ids.map((id) => q.items.find((r) => r.id === id)).filter(Boolean) as ArtRow[]
  const d = rows.find((r) => r.id === viewing.id)

  // a blank filled on the page is written into the document itself
  const fill = async (index: number, value: string) => {
    if (!d) return
    let i = -1
    const body = String(d.body ?? '').replace(BLANK, (m) => (++i === index ? value : m))
    try { await records.update('deliverables', d.id, { body }); bump() }
    catch (e) { toast(`That didn’t save: ${(e as Error)?.message ?? 'try again'}`) }
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={d?.title ?? 'Document'}>
      <div className="vw-top">
        <button className="btn ghost sm" onClick={closeView}><ChevronLeft size={15} /> Back</button>
        <span className="vw-sep" />
        {rows.length > 1 ? (
          <div className="vw-tabs" role="tablist" aria-label="Prepared together">
            {rows.map((r) => (
              <button key={r.id} role="tab" aria-selected={r.id === viewing.id} className={r.id === viewing.id ? 'on' : ''}
                title={r.title} onClick={() => view(r.id, ids)}>
                <TypeIcon t={artType(r)} size={13} /> {kindLabel(r)}
              </button>
            ))}
          </div>
        ) : d ? <div className="vw-title" title={d.title}><TypeIcon t={artType(d)} size={14} /> <span>{d.title}</span></div> : null}
        <span className="grow" />
        {d && <Tools d={d} />}
        <button className="icon-btn" aria-label="Close" onClick={closeView}><X size={16} /></button>
      </div>
      <div className="vw-body">
        <div className="vw-stage">
          {!d && (q.isLoading || !(q.response || q.error)) ? <Loading rows={6} />
            : !d ? <Empty line="This one is gone." />
              : <BlankCtx.Provider value={{ fill: (i, v) => void fill(i, v) }}><ArtBody d={d} /></BlankCtx.Provider>}
        </div>
        {d && <AskPanel key={d.id} d={d} />}
      </div>
    </div>
  )
}

/* The page, the slide and the grid always print on white: they are paper, whatever the
   app's theme. Kept here so the print window carries exactly the same rules. */
const PAGE_CSS = `
.dpage{--ink:#1D1B17;--ink-2:#2E2B25;--ink-3:#6E6A5E;--ink-4:#A39E91;--line:#ECE8DE;--line-2:#DCD6C9;--paper-2:#F1EEE6;--wash:rgba(29,27,23,.045);--acc:#26323D;
  color-scheme:light;background:#fff;color:#1D1B17;width:100%;max-width:794px;margin:0 auto;padding:60px 72px 76px;border-radius:3px;
  box-shadow:0 1px 2px rgba(0,0,0,.06),0 22px 60px -26px rgba(0,0,0,.3);font:400 14px/1.7 Inter,ui-sans-serif,system-ui,sans-serif;box-sizing:border-box}
.dp-lh{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:16px;border-bottom:2px solid var(--acc);margin-bottom:36px}
.dp-name{display:flex;align-items:center;gap:10px;font:600 15px/1.2 Inter,sans-serif;color:var(--acc)}
.dp-mark{width:30px;height:30px;flex:none;border-radius:8px;background:var(--acc);color:#fff;display:inline-grid;place-items:center;font:600 11.5px/1 Inter,sans-serif;letter-spacing:.02em}
.dp-addr{font-size:11.5px;line-height:1.55;color:var(--ink-3);text-align:right;white-space:pre-line;max-width:46%}
.dp-eyebrow{font:600 11px/1 Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.dp-title{font:400 36px/1.1 'Instrument Serif',Georgia,serif;letter-spacing:-.01em;margin:10px 0 20px;color:var(--ink)}
.dp-meta{display:flex;flex-wrap:wrap;gap:12px 40px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:28px;font-size:13px;color:var(--ink-2)}
.dp-meta small{display:block;font-size:11px;color:var(--ink-3)}
.dpage .md{color:var(--ink-2);font-size:14px;line-height:1.7}
.dpage .md p{margin:0 0 .8em}
.dpage .md h1{font:400 26px/1.2 'Instrument Serif',Georgia,serif;color:var(--ink);margin:1.4em 0 .4em}
.dpage .md h2{font:600 11.5px/1.3 Inter,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--acc);margin:30px 0 10px}
.dpage .md h3{font:600 14px/1.35 Inter,sans-serif;color:var(--ink);margin:20px 0 6px}
.dpage .md strong{color:var(--ink);font-weight:600}
.dpage .md a{color:var(--acc)}
.dpage .md ul,.dpage .md ol{margin:.3em 0 .9em;padding-left:1.3em}
.dpage .md li{margin:.2em 0}
.dpage .md table{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:13px}
.dpage .md th{text-align:left;font-weight:600;font-size:11.5px;color:var(--ink-3);border-bottom:1.5px solid var(--acc);padding:7px 8px;white-space:nowrap}
.dpage .md td{border-bottom:1px solid var(--line);padding:7px 8px;vertical-align:top}
.dpage .md hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.dpage .md blockquote{margin:12px 0;padding-left:14px;border-left:2px solid var(--line-2);color:var(--ink-3)}
.dpage .md code{font-size:12.5px;background:var(--paper-2);border-radius:4px;padding:1px 4px}
.blank{display:inline;white-space:nowrap;background:#F7EDD5;color:#6B4B0E;border:0;border-radius:4px;padding:0 5px;font:600 .9em/1.5 Inter,sans-serif}
button.blank{cursor:pointer}button.blank:hover{background:#F0DDB0}
input.blank-in{min-width:180px;outline:2px solid #C79A3A;color:#1D1B17;background:#fff}
.slide{--ink:#F4F1EA;--ink-2:rgba(244,241,234,.86);--ink-3:rgba(244,241,234,.66);--line:rgba(244,241,234,.25);--acc:#26323D;
  container-type:inline-size;position:relative;width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--acc);color:#F4F1EA;box-sizing:border-box}
.sl{position:absolute;inset:0;padding:6cqw 7cqw;display:flex;flex-direction:column}
.sl.first{justify-content:flex-end}
.sl-k{font:600 1.3cqw/1.2 Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.sl-h{font:400 5cqw/1.06 'Instrument Serif',Georgia,serif;margin:2cqw 0 0;max-width:88%}
.sl.first .sl-h{font-size:7cqw}
.sl-b{margin-top:auto;font:400 1.9cqw/1.45 Inter,sans-serif}
.sl.first .sl-b{margin-top:2.4cqw}
.sl-b .md{color:var(--ink-2);font-size:inherit;line-height:inherit}
.sl-b .md p{margin:0 0 .6em}.sl-b .md ul,.sl-b .md ol{margin:0;padding-left:1.2em}.sl-b .md li{margin:.25em 0}
.sl-b .md strong{color:var(--ink)}
.sl-b .md table{border-collapse:collapse;width:100%;font-size:inherit;margin:0}
.sl-b .md td,.sl-b .md th{border-bottom:1px solid var(--line);padding:.9cqw 1cqw;text-align:left;background:none;color:var(--ink-2)}
.sl-b .md th{font-size:.75em;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.sl-cards{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:2cqw;margin-top:auto}
.sl-card{border-top:1px solid var(--line);padding-top:1.4cqw;font:400 1.75cqw/1.4 Inter,sans-serif;color:var(--ink-2)}
.sl-card b{display:block;font:400 3.2cqw/1.05 'Instrument Serif',Georgia,serif;color:var(--ink);margin-bottom:1cqw}
.sl-num{position:absolute;right:3cqw;bottom:2.4cqw;font:500 1.2cqw Inter,sans-serif;color:var(--ink-3)}
`
if (typeof document !== 'undefined' && !document.getElementById('art-css')) {
  const s = document.createElement('style')
  s.id = 'art-css'
  s.textContent = PAGE_CSS
  document.head.appendChild(s)
}

