import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Check, CheckCheck, PenLine, MessageCircle, Inbox, ReceiptText, Lock, Play, Github, Plus } from 'lucide-react'
import { SourceMark } from './brand'
import { TEMPLATE } from './gate'
import './landing.css'

/* What somebody sees before they have an Otto of their own.

   Shown only to a visitor who is not signed in (and to someone signed in who is not a
   member here: they are never going to be let into another person's mail, so they get the
   same offer). A member never sees it: they land straight on their desk.

   The clips are the product itself. They were filmed from this app, running on an
   invented cast, by the recording rig in /studio; nothing in them is drawn for the page.
   The page carries its own colours and type so it looks the same from either app. */

const ASSET = `${import.meta.env.BASE_URL}landing/`

/* ---------------- small pieces ---------------- */

function Mark({ size = 28 }: { size?: number }) {
  return <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={size} height={size} />
}

function Orb({ size = 18, live }: { size?: number; live?: boolean }) {
  return <span className={`lp-orb${live ? ' live' : ''}`} style={{ width: size, height: size }} aria-hidden><i /></span>
}

function Install({ children = 'Get your own Otto', quiet }: { children?: ReactNode; quiet?: boolean }) {
  return (
    <a className={`lp-btn${quiet ? ' sm' : ''} primary`} href={TEMPLATE.install} target="_blank" rel="noreferrer">
      {children} <ArrowRight size={quiet ? 14 : 16} strokeWidth={2.2} />
    </a>
  )
}

/** Fade a block up the first time it comes into view. */
function Reveal({ children, as: Tag = 'div', className = '', delay = 0 }: {
  children: ReactNode; as?: 'div' | 'section' | 'li' | 'header'; className?: string; delay?: number
}) {
  const ref = useRef<HTMLElement | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect() } }, { rootMargin: '0px 0px -8% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const T = Tag as 'div'
  return <T ref={ref as never} className={`lp-rv${seen ? ' in' : ''} ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>{children}</T>
}

/* ---------------- a clip ---------------- */

type Beats = Record<string, number>

/* Each clip is a looping, silent film of the app. It plays only while it is on screen.
   Beside the film sits a small file saying when each beat starts: the hero's captions
   follow those, and on a narrow screen `pan:<x>` beats say which part of the frame to
   look at, so a phone shows the part where something is happening at a readable size. */
function Clip({ name, alt, ratio = '1180 / 760', eager, look = 0, where = 'otto.apps.lemma.work', onBeats, onTime }: {
  name: string; alt: string; ratio?: string; eager?: boolean
  /** where a narrow screen looks before the film says otherwise: 0 is the left edge, 100 the right */
  look?: number
  /** what the window's address line says: the app, unless the film is of somewhere else */
  where?: string
  onBeats?: (b: Beats, seconds: number) => void; onTime?: (t: number) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const view = useRef<HTMLDivElement>(null)
  const pans = useRef<{ at: number; x: number }[]>([])
  const [held, setHeld] = useState(false)       // the visitor asked for less motion, or paused it
  const [started, setStarted] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`${ASSET}${name}.json`).then((r) => r.json()).then((j: { seconds: number; beats: Beats }) => {
      if (!live) return
      pans.current = Object.entries(j.beats).filter(([k]) => k.startsWith('pan:'))
        .map(([k, at]) => ({ at, x: Number(k.slice(4).split('#')[0]) })).sort((a, b) => a.at - b.at)
      onBeats?.(j.beats, j.seconds)
    }).catch(() => { /* the film plays without its captions */ })
    return () => { live = false }
  }, [name])

  useEffect(() => {
    const v = video.current
    if (!v) return
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (calm) { setHeld(true); return }
    if (typeof IntersectionObserver === 'undefined') { void v.play().catch(() => setHeld(true)); return }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) void v.play().catch(() => setHeld(true))
      else v.pause()
    }, { threshold: 0.3 })
    io.observe(v)
    return () => io.disconnect()
  }, [])

  const tick = () => {
    const v = video.current
    if (!v) return
    const t = v.currentTime
    onTime?.(t)
    let x = pans.current.length ? pans.current[0].x : look
    for (const p of pans.current) if (t >= p.at) x = p.x
    view.current?.style.setProperty('--look', `${x}%`)
  }

  const toggle = () => {
    const v = video.current
    if (!v) return
    if (v.paused) { setHeld(false); void v.play().catch(() => setHeld(true)) } else { v.pause(); setHeld(true) }
  }

  return (
    <figure className="lp-clip">
      <div className="lp-win">
        <div className="lp-win-bar" aria-hidden><i /><i /><i /><span><Lock size={10} /> {where}</span></div>
        <div className="lp-win-view" ref={view} style={{ aspectRatio: ratio, ['--look' as string]: `${look}%` }}>
          <video
            ref={video} muted loop playsInline preload={eager ? 'auto' : 'none'} poster={`${ASSET}${name}.jpg`}
            aria-label={alt} onTimeUpdate={tick} onPlaying={() => setStarted(true)} onClick={toggle}
          >
            <source src={`${ASSET}${name}.mp4`} type="video/mp4" />
          </video>
          {held && (
            <button className="lp-play" onClick={toggle} aria-label="Play the clip">
              <Play size={18} fill="currentColor" /> {started ? 'Resume' : 'Play'}
            </button>
          )}
        </div>
      </div>
    </figure>
  )
}

/* ---------------- the hero film, and the four lines under it ---------------- */

const STEPS: { beat: string; title: string; line: string }[] = [
  { beat: 'reads', title: 'Reads', line: 'Three weeks of mail, calendar and call notes.' },
  { beat: 'finds', title: 'Finds', line: 'Everything still open: who owes what, since when.' },
  { beat: 'prepared', title: 'Prepares', line: 'The proposal, from Tuesday’s call, Sam’s email and the last one she sent.' },
  { beat: 'yours', title: 'You send', line: 'One word changed. Nothing leaves without your click.' },
]

function HeroFilm() {
  const [beats, setBeats] = useState<Beats | null>(null)
  const [at, setAt] = useState(0)
  let step = 0
  if (beats) STEPS.forEach((s, i) => { if (at >= (beats[s.beat] ?? Infinity)) step = i })
  return (
    <div className="lp-film">
      <Clip name="hero" eager ratio="1400 / 875" onBeats={(b) => setBeats(b)} onTime={setAt}
        alt="Otto reading a mailbox, listing what is still open, then a prepared proposal being opened, edited and sent." />
      <ol className="lp-steps">
        {STEPS.map((s, i) => (
          <li key={s.beat} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <span className="lp-step-n">{i + 1}</span>
            <b>{s.title}</b>
            <span>{s.line}</span>
          </li>
        ))}
      </ol>
      <p className="lp-fine">A first run, filmed in Otto itself with the waiting shortened. Every name in it is invented.</p>
    </div>
  )
}

/* ---------------- chapters ---------------- */

function Chapter({ n, id, title, children, clip, alt, extra, where, look }: {
  n: string; id?: string; title: string; children: ReactNode; clip: string; alt: string; extra?: ReactNode; where?: string; look?: number
}) {
  return (
    <section className="lp-ch" id={id}>
      <Reveal as="header" className="lp-ch-h">
        <div>
          <span className="lp-num">{n}</span>
          <h2>{title}</h2>
        </div>
        <div className="lp-ch-say">
          <p>{children}</p>
          {extra}
        </div>
      </Reveal>
      <Reveal><Clip name={clip} alt={alt} where={where} look={look} /></Reveal>
    </section>
  )
}

const ALSO: { icon: typeof Check; title: string; line: string }[] = [
  { icon: CheckCheck, title: 'Knows when it is handled', line: 'Items you already dealt with are closed for you.' },
  { icon: PenLine, title: 'Sounds like you', line: 'Your voice is learned from the mail you have sent.' },
  { icon: MessageCircle, title: 'Not right?', line: 'Correct it once in plain words. Otto reads that before it writes again.' },
  { icon: Inbox, title: 'Every mailbox', line: 'Work and personal, on one desk.' },
  { icon: ReceiptText, title: 'Invoices like your last one', line: 'Same format, same tax and bank details, new numbers.' },
  { icon: Lock, title: 'Private for each teammate', line: 'Add your team. Everyone sees only their own mail.' },
]

const FAQ: { q: string; a: string }[] = [
  { q: 'What is Lemma?', a: 'The workspace Otto runs in. The install button takes you there, creates your account and makes your own copy of Otto. You open it in the browser; there is nothing to download.' },
  { q: 'Who can see my mail?', a: 'Only you. Your copy is yours alone. If you add your team, each person connects their own mailbox and sees only their own items and drafts.' },
  { q: 'Will it send email on its own?', a: 'No. Otto drafts and you press Send, and every send can be taken back for a few seconds. The one thing it sends by itself is the morning brief, and that goes only to your own inbox.' },
  { q: 'How soon do I see something?', a: 'Installing takes about two minutes. After you connect your mail, the first open items usually appear within ten minutes, and the rest follows while you carry on.' },
  { q: 'What does it read?', a: 'Your mail, your calendar and, if you connect them, your meeting notes. Newsletters, notifications and cold pitches are set aside and never become to-dos.' },
  { q: 'Can I remove it?', a: 'Yes. Disconnect your mailbox or delete your copy whenever you like. It is open source, so you can also read exactly what it does.' },
]

/* ---------------- the page ---------------- */

export default function Landing({ signIn, visitor, onSwitch, member }: {
  /** send a visitor to sign in (absent when the page is only being looked at) */
  signIn?: () => void
  /** someone signed in who has no Otto here: their name, for one line at the top */
  visitor?: string
  onSwitch?: () => void
  /** a member previewing the page: the way back to their desk */
  member?: boolean
}) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    document.body.classList.add('lp-body')
    const title = document.title
    document.title = 'Otto: a chief of staff for your inbox'
    const on = () => setStuck(window.scrollY > 12)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => { document.body.classList.remove('lp-body'); document.title = title; window.removeEventListener('scroll', on) }
  }, [])

  return (
    <div className="lp">
      {visitor && (
        <div className="lp-note">
          <span>{visitor}, this Otto belongs to someone else. Yours is one click away.</span>
          {onSwitch && <button onClick={onSwitch}>Use another account</button>}
        </div>
      )}

      <header className={`lp-top${stuck ? ' stuck' : ''}`}>
        <div className="lp-wrap lp-top-in">
          <a className="lp-brand" href="#top" aria-label="Otto"><Mark /> <span>Otto</span></a>
          <nav className="lp-nav" aria-label="Sections">
            <a href="#does">What it does</a>
            <a href="#charge">Privacy</a>
            <a href="#start">How to start</a>
          </nav>
          <span className="lp-grow" />
          {member ? <a className="lp-btn sm ghost" href={import.meta.env.BASE_URL}>Open Otto</a>
            : signIn ? <button className="lp-btn sm ghost" onClick={signIn}>Sign in</button> : null}
          <Install quiet>Get your Otto</Install>
        </div>
      </header>

      <main id="top">
        {/* ---- hero ---- */}
        <section className="lp-hero">
          <div className="lp-wrap">
            <div className="lp-hero-copy">
              <span className="lp-eyebrow"><Orb size={14} live /> Your AI chief of staff</span>
              <h1>The work you promised is already done.</h1>
              <p className="lp-lede">
                Otto reads your mail, calendar and meeting notes, catches every promise you made, and prepares the reply,
                the invite or the document before you sit down. You read it and press Send.
              </p>
              <div className="lp-cta">
                <Install />
                <a className="lp-btn ghost" href="#does">See what it does</a>
              </div>
              <p className="lp-under">Your own private copy, set up in a few minutes. Open source.</p>
            </div>
            <HeroFilm />
          </div>
        </section>

        {/* ---- works with ---- */}
        <section className="lp-with">
          <div className="lp-wrap">
            <p>Reads where your promises are made</p>
            <ul>
              {[['gmail', 'Gmail'], ['outlook', 'Outlook'], ['google_calendar', 'Google Calendar'], ['googlemeet', 'Google Meet'], ['granola', 'Granola'], ['slack', 'Slack']].map(([app, label]) => (
                <li key={app}><SourceMark app={app} /> {label}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---- the problem ---- */}
        <section className="lp-why">
          <div className="lp-wrap lp-why-in">
            <Reveal><h2>The hard work gets done. The small promises slip.</h2></Reveal>
            <Reveal className="lp-slips" delay={80}>
              <ul>
                <li><i className="mine" /><span>The proposal you said you would send by Friday</span><em>2d</em></li>
                <li><i className="mine" /><span>The introduction you offered on a call</span><em>5d</em></li>
                <li><i className="theirs" /><span>The person still waiting to hear back</span><em>1w</em></li>
              </ul>
              <p>They sit in a hundred threads, and you remember them when someone chases.</p>
            </Reveal>
          </div>
        </section>

        {/* ---- what it does ---- */}
        <div className="lp-wrap" id="does">
          <Chapter n="01" title="It catches every promise." clip="caught"
            alt="Otto’s Today page listing open items by topic, then one item opened to show the sentence in the email it came from.">
            Otto keeps only what is still open: what you owe, what you are owed, who, and since when. Each item links back to
            the sentence it came from.
          </Chapter>

          <Chapter n="02" title="A reply, an invite, or the document." clip="prepared"
            alt="A prepared meeting invitation with three free times; one is picked and the invite is sent."
            extra={<ul className="lp-tags"><li>The email, in your voice</li><li>Times you are really free</li><li>The proposal or invoice itself</li></ul>}>
            If the answer is a sentence, Otto writes the email. If it needs a call, it offers times you are really free. If you
            promised a proposal or an invoice, it writes that too, following the last one you sent.
          </Chapter>

          <Chapter n="03" title="One email at 7:30." clip="brief" where="Your inbox, 7:31 AM"
            alt="The morning brief email being opened: what needs you today, the day’s meetings, and what is ready to send.">
            Today’s meetings, what you owe the people in them, and what is waiting for your Send. That is the only time Otto
            interrupts you.
          </Chapter>

          <Chapter n="04" title="Ask for the work itself." clip="asked" look={58}
            alt="A question typed to Otto, which reads three agency quotes and answers with a one-page comparison."
            extra={<ul className="lp-tags ask"><li>What did I promise on my last call?</li><li>Compare the three agency quotes</li><li>Who am I waiting on this week?</li></ul>}>
            Compare three quotes. Research a company before the first call. Recap a month of threads with a customer. Otto
            reads what it needs, says where each fact came from, and files the document.
          </Chapter>

          <Chapter n="05" title="Pipelines that build themselves." clip="boards" look={100}
            alt="A sales board and a hiring board, each card showing its stage, why it moved and how long it has been there.">
            When three or more people are in the same process, whether hiring, sales or fundraising, Otto starts a board in your
            words and moves the cards as the mail moves.
          </Chapter>
        </div>

        {/* ---- also ---- */}
        <section className="lp-also">
          <div className="lp-wrap">
            <Reveal><h2>And the quiet things.</h2></Reveal>
            <ul>
              {ALSO.map((a, i) => (
                <Reveal as="li" key={a.title} delay={(i % 3) * 70}>
                  <span className="lp-ic"><a.icon size={18} strokeWidth={1.9} /></span>
                  <b>{a.title}</b>
                  <span>{a.line}</span>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ---- you stay in charge ---- */}
        <section className="lp-charge" id="charge">
          <div className="lp-wrap">
            <Reveal>
              <span className="lp-eyebrow dark">You stay in charge</span>
              <h2>Otto prepares.<br />You approve.</h2>
            </Reveal>
            <ul>
              <Reveal as="li"><Check size={18} strokeWidth={2.4} /><div><b>Nothing leaves without your click.</b><span>Every email and invite waits for your Send, and can be taken back for a few seconds after.</span></div></Reveal>
              <Reveal as="li" delay={70}><Check size={18} strokeWidth={2.4} /><div><b>It is your own copy.</b><span>Your mail stays in your own workspace. Nobody else is in it unless you add them.</span></div></Reveal>
              <Reveal as="li"><Check size={18} strokeWidth={2.4} /><div><b>Careful on purpose.</b><span>An invitation is not an offer, silence is not a no, and cold pitches never become to-dos.</span></div></Reveal>
              <Reveal as="li" delay={70}><Check size={18} strokeWidth={2.4} /><div><b>Open source.</b><span>Read every line, or change it to fit how you work. <a href={TEMPLATE.repo} target="_blank" rel="noreferrer"><Github size={13} /> See the code</a></span></div></Reveal>
            </ul>
          </div>
        </section>

        {/* ---- three steps ---- */}
        <section className="lp-start" id="start">
          <div className="lp-wrap">
            <Reveal><h2>Three steps to a clear desk.</h2></Reveal>
            <ol>
              <Reveal as="li"><span>1</span><b>Install your copy</b><p>One click. It takes about two minutes, and it is yours alone.</p></Reveal>
              <Reveal as="li" delay={80}><span>2</span><b>Connect your mail</b><p>Sign in with Google or Microsoft. Calendar and meeting notes are optional.</p></Reveal>
              <Reveal as="li" delay={160}><span>3</span><b>See what is waiting</b><p>Otto reads your last three weeks and shows you what is still open.</p></Reveal>
            </ol>
            <Reveal className="lp-start-cta">
              <Install />
              <span>The button opens Lemma, the workspace Otto runs in, and makes your copy there.</span>
            </Reveal>
          </div>
        </section>

        {/* ---- questions ---- */}
        <section className="lp-faq">
          <div className="lp-wrap lp-faq-in">
            <Reveal><h2>Questions</h2></Reveal>
            <div>
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}<Plus size={18} strokeWidth={1.8} /></summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ---- closing ---- */}
        <section className="lp-end">
          <div className="lp-wrap">
            <Reveal>
              <Orb size={54} live />
              <h2>Start tomorrow with a clear desk.</h2>
              <div className="lp-cta"><Install /></div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap">
          <span className="lp-brand"><Mark size={22} /> <span>Otto</span></span>
          <span>Built by Ayush Gautam on <a href="https://lemma.work" target="_blank" rel="noreferrer">Lemma</a></span>
          <span className="lp-grow" />
          <a href={TEMPLATE.repo} target="_blank" rel="noreferrer">Open source on GitHub</a>
          {signIn && <button onClick={signIn}>Sign in</button>}
        </div>
      </footer>
    </div>
  )
}
