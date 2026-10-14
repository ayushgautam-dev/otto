import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Check, Lock, Play, Github, Plus, Mail, FileText } from 'lucide-react'
import { SourceMark } from './brand'
import { TEMPLATE } from './gate'
import './landing.css'

/* Otto introducing himself to somebody who does not have one yet.

   Lemma is a place for AI teammates, so the page is a teammate's introduction and not a
   product tour. It is short on purpose, six blocks:
     hello (with one film of a morning's work) · reach me by email or WhatsApp ·
     my work (four samples in one frame, as tabs) · how I work · interview me · hire me.
   Written in the first person; the films do the telling.

   Shown only to a visitor who is not signed in (and to someone signed in who is not a
   member here: they are never going to be let into another person's mail, so they get the
   same offer). A member never sees it: they land straight on their desk.

   The films and the three pictures of work are the product itself, recorded from this app
   running on an invented cast by the rig in /studio. The page carries its own colours and
   type so it looks the same from either app. */

const ASSET = `${import.meta.env.BASE_URL}landing/`

/* ---------------- small pieces ---------------- */

function Mark({ size = 28 }: { size?: number }) {
  return <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={size} height={size} />
}

function Orb({ size = 18, live }: { size?: number; live?: boolean }) {
  return <span className={`lp-orb${live ? ' live' : ''}`} style={{ width: size, height: size }} aria-hidden><i /></span>
}

/** The one thing the page asks for: a copy of Otto, made on Lemma. */
function Hire({ children = 'Hire Otto', quiet }: { children?: ReactNode; quiet?: boolean }) {
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

const calm = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/* ---------------- a film ---------------- */

type Beats = Record<string, number>

/** The window every film and picture sits in. */
function Win({ where = 'otto.apps.lemma.work', children }: { where?: string; children: ReactNode }) {
  return (
    <div className="lp-win">
      <div className="lp-win-bar" aria-hidden><i /><i /><i /><span><Lock size={10} /> {where}</span></div>
      {children}
    </div>
  )
}

/* Each film is a silent recording of the app. It plays only while it is on screen.
   Beside it sits a small file saying when each beat starts: the hero's captions follow
   those, and on a narrow screen `pan:<x>` beats say which part of the frame to look at,
   so a phone shows the part where something is happening at a readable size. */
function Clip({ name, alt, ratio = '1180 / 760', eager, look = 0, where, once, onBeats, onTime, onEnded }: {
  name: string; alt: string; ratio?: string; eager?: boolean
  /** where a narrow screen looks before the film says otherwise: 0 is the left edge, 100 the right */
  look?: number
  /** what the window's address line says: the app, unless the film is of somewhere else */
  where?: string
  /** play through once and say when it ends, instead of looping */
  once?: boolean
  onBeats?: (b: Beats, seconds: number) => void
  /** seconds in, and how much of the film that is (0 to 1) */
  onTime?: (t: number, part: number) => void
  onEnded?: () => void
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
    if (calm()) { setHeld(true); return }
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
    onTime?.(t, v.duration ? t / v.duration : 0)
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
      <Win where={where}>
        <div className="lp-win-view" ref={view} style={{ aspectRatio: ratio, ['--look' as string]: `${look}%` }}>
          <video
            ref={video} muted loop={!once} playsInline preload={eager ? 'auto' : 'none'} poster={`${ASSET}${name}.jpg`}
            aria-label={alt} onTimeUpdate={tick} onPlaying={() => setStarted(true)} onClick={toggle} onEnded={onEnded}
          >
            <source src={`${ASSET}${name}.mp4`} type="video/mp4" />
          </video>
          {held && (
            <button className="lp-play" onClick={toggle} aria-label="Play the film">
              <Play size={18} fill="currentColor" /> {started ? 'Resume' : 'Play'}
            </button>
          )}
        </div>
      </Win>
    </figure>
  )
}

/* ---------------- the first film, and the four lines that stand in for a description ---------------- */

const STEPS: { beat: string; line: string }[] = [
  { beat: 'reads', line: 'I read your mail' },
  { beat: 'finds', line: 'I find what is open' },
  { beat: 'prepared', line: 'I prepare the work' },
  { beat: 'yours', line: 'You check it and send' },
]

function HeroFilm() {
  const [beats, setBeats] = useState<Beats | null>(null)
  const [at, setAt] = useState(0)
  let step = 0
  if (beats) STEPS.forEach((s, i) => { if (at >= (beats[s.beat] ?? Infinity)) step = i })
  return (
    <div className="lp-film">
      <Clip name="hero" eager onBeats={(b) => setBeats(b)} onTime={(t) => setAt(t)}
        alt="Otto’s desk on an ordinary morning: the loose ends, then one of them opened with the email it answers, a prepared proposal, one word changed, and sent." />
      <ol className="lp-steps">
        {STEPS.map((s, i) => (
          <li key={s.beat} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <span className="lp-step-n">{i + 1}</span>
            <b>{s.line}</b>
          </li>
        ))}
      </ol>
      <p className="lp-fine">Filmed in Otto itself. Every name in it is invented.</p>
    </div>
  )
}

/* ---------------- away from the desk ---------------- */

/* Otto also works by email (a reply to the morning brief reaches him) and on WhatsApp,
   and sends the document back in the same conversation. Those conversations happen
   outside this app, so these two are the only things on the page that are drawn and not
   filmed. What is in them is work Otto does: a brief before a first meeting, a comparison
   written up. Nothing here shows him sending to anyone but the person themselves. */
function Reach() {
  return (
    <section className="lp-reach-sec">
      <div className="lp-wrap">
        <Reveal as="header" className="lp-ch-h">
          <h2>Email me, or WhatsApp me.</h2>
          <p>I come back with the work.</p>
        </Reveal>
        <div className="lp-reach">
          <Reveal className="lp-chat">
            <div className="lp-chat-top">
              <span className="lp-chat-face"><Mark size={24} /></span>
              <span><b>Otto</b><small>online</small></span>
              <span className="lp-via"><WhatsAppMark /> WhatsApp</span>
            </div>
            <div className="lp-chat-log">
              <p className="me" style={{ ['--i' as string]: 0 }}>I meet Felix from Tessel Foods at 3. Brief me.<time>2:10</time></p>
              <p className="file" style={{ ['--i' as string]: 1 }}>
                <span className="lp-file"><i><FileText size={18} strokeWidth={1.8} /></i><span><b>Brief: Felix Moreau, Tessel Foods</b><small>Document · 1 page</small></span></span>
                <time>2:12</time>
              </p>
              <p style={{ ['--i' as string]: 2 }}>
                Short version: he runs supply chain for nine cold-chain depots, he wrote to you after the Freight Expo, and
                dispatch is his weak spot. Ask how many loads leave late each week.<time>2:12</time>
              </p>
            </div>
          </Reveal>
          <Reveal className="lp-mail" delay={120}>
            <div className="lp-mail-top">
              <b>Re: Thu 15 Oct: 3 meetings, 3 ready to send</b>
              <span className="lp-via"><Mail size={13} /> Email</span>
            </div>
            <div className="lp-mail-log">
              <div className="me" style={{ ['--i' as string]: 1 }}>
                <span className="lp-mail-who"><i>PN</i><b>You</b><time>7:42 AM</time></span>
                <p>Compare the three agency quotes and tell me which to pick.</p>
              </div>
              <div style={{ ['--i' as string]: 2 }}>
                <span className="lp-mail-who"><i className="otto"><Mark size={18} /></i><b>Otto</b><time>7:51 AM</time></span>
                <p>
                  Go with Brightwave. It is the only quote that includes the build, and once Studio Kite’s build partner is
                  added it is also the cheapest. Julia’s price holds until Friday. The comparison is attached.
                </p>
                <span className="lp-file att"><i><FileText size={18} strokeWidth={1.8} /></i><span><b>Website relaunch: three quotes compared</b><small>Document · 1 page</small></span></span>
              </div>
            </div>
            <span className="lp-mail-foot">A reply to this morning’s brief</span>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

function WhatsAppMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="#25D366" d="M17.472 14.382c-.297-.149-1.758-.867-2.030-.967-.273-.099-.471-.148-.670.150-.197.297-.767.966-.940 1.164-.173.199-.347.223-.644.075-.297-.150-1.255-.463-2.390-1.475-.883-.788-1.480-1.761-1.653-2.059-.173-.297-.018-.458.130-.606.134-.133.298-.347.446-.520.149-.174.198-.298.298-.497.099-.198.050-.371-.025-.520-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.500-.669-.510-.173-.008-.371-.010-.570-.010-.198 0-.520.074-.792.372-.272.297-1.040 1.016-1.040 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.200 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.360.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.570-.347m-5.421 7.403h-.004a9.870 9.870 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.860 9.860 0 01-1.510-5.260c.001-5.450 4.436-9.884 9.888-9.884 2.640 0 5.122 1.030 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.450-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.050 0C5.495 0 .160 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.890-5.335 11.893-11.893a11.821 11.821 0 00-3.480-8.413z" />
    </svg>
  )
}

/* ---------------- my work: four samples in one frame ---------------- */

/* The three pictures are pieces of the app's item panel, photographed as they are (the
   studio's `kinds` scene saves them). They are not a film: the hero already shows them
   being opened and sent. */
const KINDS: { img: string; label: string; alt: string }[] = [
  { img: 'kind-reply', label: 'A reply', alt: 'A reply to Elena, written and ready to send.' },
  { img: 'kind-invite', label: 'An invite', alt: 'An invitation for the Lumen Health demo with three free times to choose from.' },
  { img: 'kind-document', label: 'A document', alt: 'The pilot proposal for Acme Freight, written as a document.' },
]

interface Work { key: string; tab: string; title: string; line: string; alt: string; clip?: string; where?: string; look?: number; ratio?: string }

const WORK: Work[] = [
  { key: 'kinds', tab: 'Finished work', title: 'The work arrives finished.', line: 'A reply, an invite or the document.',
    alt: 'Three things Otto prepared: a reply, an invitation and a document.' },
  { key: 'brief', tab: 'Morning brief', title: 'I brief you at 7:30.', line: 'One email. Then I leave you alone.', clip: 'brief', where: 'Your inbox, 7:31 AM',
    alt: 'The morning brief email being opened: what needs you today, the day’s meetings, and what is ready to send.' },
  { key: 'delegated', tab: 'Delegate', title: 'Ask me for the work.', line: 'I do the reading and write it up.', clip: 'delegated', look: 58,
    alt: 'A job handed to Otto: it works in the background, then comes back with a customer review and two prepared emails.' },
  { key: 'boards', tab: 'Pipeline', title: 'I keep your pipeline moving.', line: 'Open a lead, send, and the card moves.', clip: 'boards', look: 100, ratio: '1290 / 830',
    alt: 'A sales board: a new lead is opened, a prepared invitation is sent, and the lead’s card moves to the next stage.' },
]

/** how long the pictures hold before the frame moves on by itself */
const HOLD = 6500

/* One frame, four tabs. Left alone, it plays each sample and moves to the next; the
   moment the visitor picks a tab it stops moving on and stays where they put it. */
function WorkStage() {
  const [at, setAt] = useState(0)
  const [auto, setAuto] = useState(() => !calm())
  const [seen, setSeen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const w = WORK[at]

  /** how far through the current sample we are, drawn as a line under its tab */
  const part = useCallback((p: number) => { tabs.current?.style.setProperty('--part', String(Math.max(0, Math.min(1, p)))) }, [])
  const next = useCallback(() => { part(0); setAt((i) => (i + 1) % WORK.length) }, [part])
  const pick = (i: number) => { setAuto(false); part(0); setAt(i) }

  useEffect(() => {
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // the pictures have no film to end, so they hold for a few seconds
  useEffect(() => {
    if (w.clip || !auto || !seen) return
    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      const p = (performance.now() - t0) / HOLD
      if (p >= 1) { next(); return }
      part(p)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [at, auto, seen, w.clip, next, part])

  return (
    <section className="lp-work" id="work">
      <div className="lp-wrap">
        <Reveal as="header" className="lp-work-h">
          <span className="lp-kicker ink">My work</span>
          <div className="lp-work-say" key={w.key}>
            <h2>{w.title}</h2>
            <p>{w.line}</p>
          </div>
        </Reveal>
        <Reveal>
          <div className={`lp-tabs${auto ? ' auto' : ''}`} role="tablist" aria-label="Samples of my work" ref={tabs}>
            {WORK.map((x, i) => (
              <button key={x.key} role="tab" aria-selected={i === at} className={i === at ? 'on' : ''} onClick={() => pick(i)}>
                {x.tab}
              </button>
            ))}
          </div>
          <div className="lp-stage" ref={box} role="tabpanel" aria-label={w.title}>
            {w.clip
              ? <Clip key={w.key} name={w.clip} alt={w.alt} where={w.where} look={w.look} ratio={w.ratio}
                  once={auto} onEnded={auto ? next : undefined} onTime={(_t, p) => { if (auto) part(p) }} />
              : (
                <figure className="lp-clip" key={w.key}>
                  <Win>
                    <div className="lp-win-view kinds" style={{ aspectRatio: '1180 / 760' }} aria-label={w.alt}>
                      <ul>
                        {KINDS.map((k) => (
                          <li key={k.img}>
                            <b>{k.label}</b>
                            <img src={`${ASSET}${k.img}.png`} alt={k.alt} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Win>
                </figure>
              )}
          </div>
        </Reveal>
      </div>
    </section>
  )
}

const WITH: [string, string][] = [
  ['gmail', 'Gmail'], ['outlook', 'Outlook'], ['google_calendar', 'Google Calendar'],
  ['googlemeet', 'Meet'], ['granola', 'Granola'], ['slack', 'Slack'],
]

const SKILLS = [
  'Writes in your voice', 'Closes what you already handled', 'Invoices like your last one',
  'Several mailboxes', 'Private for each teammate',
]

const FAQ: { q: string; a: string }[] = [
  { q: 'Where do you live?', a: 'On Lemma, a workspace for AI teammates. The button creates your account and your own copy of me. There is nothing to download.' },
  { q: 'What do you cost?', a: 'Nothing to start. I am also open source, so you can run me yourself for free.' },
  { q: 'Who can see my mail?', a: 'Only you. If you add your team, each person sees only their own.' },
  { q: 'Do you send on your own?', a: 'No. I draft and you press Send. The one thing I send myself is your morning brief, and that goes only to you.' },
  { q: 'Can I let you go?', a: 'Yes. Disconnect your mailbox or delete your copy whenever you like.' },
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
    document.title = 'Otto, your AI chief of staff'
    const on = () => setStuck(window.scrollY > 12)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => { document.body.classList.remove('lp-body'); document.title = title; window.removeEventListener('scroll', on) }
  }, [])

  return (
    <div className="lp">
      {visitor && (
        <div className="lp-note">
          <span>{visitor}, I already work for someone here. Your own Otto is one click away.</span>
          {onSwitch && <button onClick={onSwitch}>Use another account</button>}
        </div>
      )}

      <header className={`lp-top${stuck ? ' stuck' : ''}`}>
        <div className="lp-wrap lp-top-in">
          <a className="lp-brand" href="#top" aria-label="Otto"><Mark /> <span>Otto</span></a>
          <nav className="lp-nav" aria-label="Sections">
            <a href="#work">My work</a>
            <a href="#how">How I work</a>
            <a href="#start">First day</a>
          </nav>
          <span className="lp-grow" />
          {member ? <a className="lp-btn sm ghost" href={import.meta.env.BASE_URL}>Open Otto</a>
            : signIn ? <button className="lp-btn sm ghost" onClick={signIn}>Sign in</button> : null}
          <Hire quiet />
        </div>
      </header>

      <main id="top">
        {/* ---- hello ---- */}
        <section className="lp-hero">
          <div className="lp-wrap">
            <div className="lp-hero-copy">
              <span className="lp-face"><Mark size={46} /></span>
              <span className="lp-eyebrow">AI chief of staff <i /> a teammate on Lemma</span>
              <h1>Hi, I’m Otto.<br />I keep your promises.</h1>
              <div className="lp-cta">
                <Hire />
                <a className="lp-btn ghost" href="#work">See my work</a>
              </div>
              {/* the top of a résumé, in one line */}
              <ul className="lp-facts">
                <li>Reports only to you</li>
                <li>Free to start</li>
                <li className="with">
                  Works with
                  <span className="lp-marks">{WITH.map(([app, label]) => <span key={app} title={label}><SourceMark app={app} /></span>)}</span>
                </li>
              </ul>
            </div>
            <HeroFilm />
          </div>
        </section>

        {/* ---- reach me ---- */}
        <Reach />

        {/* ---- my work ---- */}
        <WorkStage />

        {/* ---- how I work ---- */}
        <section className="lp-charge" id="how">
          <div className="lp-wrap">
            <Reveal>
              <span className="lp-kicker">How I work</span>
              <h2>I prepare.<br />You approve.</h2>
            </Reveal>
            <div>
              <ul className="lp-rules">
                <Reveal as="li"><Check size={19} strokeWidth={2.4} /><span>Nothing is sent without your click.</span></Reveal>
                <Reveal as="li" delay={70}><Check size={19} strokeWidth={2.4} /><span>Your mail stays yours. You get your own copy of me.</span></Reveal>
                <Reveal as="li" delay={140}><Check size={19} strokeWidth={2.4} /><span>I am open source. <a href={TEMPLATE.repo} target="_blank" rel="noreferrer"><Github size={14} /> See the code</a></span></Reveal>
              </ul>
              <Reveal className="lp-skills" delay={120}>
                <span>Other skills</span>
                <ul>{SKILLS.map((s) => <li key={s}>{s}</li>)}</ul>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ---- interview me ---- */}
        <section className="lp-faq">
          <div className="lp-wrap lp-faq-in">
            <Reveal><h2>Interview me</h2></Reveal>
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

        {/* ---- hire me: the first day, and the button ---- */}
        <section className="lp-end" id="start">
          <div className="lp-wrap">
            <Reveal>
              <Orb size={54} live />
              <h2>Let me clear your desk.</h2>
              <ol className="lp-day" aria-label="My first day">
                <li><span>1</span>Hire me</li>
                <li><span>2</span>Connect your mail</li>
                <li><span>3</span>See what is waiting</li>
              </ol>
              <div className="lp-cta"><Hire /></div>
              <p className="lp-under">Free to start. Open source.</p>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap">
          <span className="lp-brand"><Mark size={22} /> <span>Otto</span></span>
          <span>An AI teammate on <a href="https://lemma.work" target="_blank" rel="noreferrer">Lemma</a>, built by Ayush Gautam</span>
          <span className="lp-grow" />
          <a href={TEMPLATE.repo} target="_blank" rel="noreferrer">Open source on GitHub</a>
          {signIn && <button onClick={signIn}>Sign in</button>}
        </div>
      </footer>
    </div>
  )
}
