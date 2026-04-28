/**
 * Claude Talkie-Walkie Viewer — live pixel-art console dashboard.
 *
 * Connects to one or more talkie-walkie nodes via SSE (`GET /events`) and
 * renders an animated TUI: per-node panel with an 8×8 half-block avatar
 * that reacts to activity, an activity sparkline, and the latest messages.
 *
 * Usage:
 *   claude-talkie-walkie viewer name=host[,name=host…]   (CLI args)
 *   PEERS=name=host,… INTERCOM_SECRET=… claude-talkie-walkie viewer
 *
 * Auth: uses INTERCOM_SECRET from env, just like the rest of the system.
 */
import * as http from 'node:http'
import * as https from 'node:https'

interface ActivityEvent {
  type: 'send' | 'recv'
  peer: string
  preview: string
  timestamp: string
}

interface NodeState {
  name: string
  host: string
  protocol: 'http' | 'https'
  status: 'connecting' | 'connected' | 'error'
  lastError?: string
  events: ActivityEvent[]
  sentTotal: number
  recvTotal: number
  /** Per-second buckets for the last SPARK_SECONDS, indexed by epoch second. */
  buckets: Map<number, number>
  /** Epoch ms of the most recent event for animation. */
  lastEventAt: number
  lastEventType?: 'send' | 'recv'
}

const NODE_EVENT_BUFFER = 200
const SPARK_SECONDS = 30
const FRAME_INTERVAL_MS = 100
const RECONNECT_DELAY_MS = 3000

// ── ANSI helpers ───────────────────────────────────────────────────────

const ESC = '\x1b['
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const CLEAR_BELOW = `${ESC}J`
const CURSOR_HOME = `${ESC}H`
const HIDE_CURSOR = `${ESC}?25l`
const SHOW_CURSOR = `${ESC}?25h`
const ALT_SCREEN_ON = `${ESC}?1049h`
const ALT_SCREEN_OFF = `${ESC}?1049l`

const FG = {
  gray: `${ESC}90m`,
  red: `${ESC}91m`,
  green: `${ESC}92m`,
  yellow: `${ESC}93m`,
  blue: `${ESC}94m`,
  magenta: `${ESC}95m`,
  cyan: `${ESC}96m`,
  white: `${ESC}97m`,
} as const

// ── Pixel-art sprites (8×8, top-down rows) ─────────────────────────────
// 1 = lit, 0 = transparent. Rendered with half-blocks: each pair of rows
// becomes one terminal row using ▀ / ▄ / █ depending on which pixels are lit.

type Sprite = ReadonlyArray<ReadonlyArray<0 | 1>>

const SPRITE_IDLE: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1], // eyes
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1], // small smile
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_BLINK: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1], // eyes shut
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_TALK_A: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 0, 0, 0, 1, 1], // mouth open
  [1, 1, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_TALK_B: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 0, 0, 1, 1, 1], // mouth small
  [1, 1, 1, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_LISTEN: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 1], // ear pokes out top-right
  [0, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_ERROR: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 0, 0, 1, 1, 1], // X eye left
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 0, 0, 1, 1, 1], // X eye right (mirror)
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_CONNECTING: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

/** Render an 8-row sprite with one foreground color into 4 terminal rows. */
function renderSprite(sprite: Sprite, fg: string): string[] {
  const lines: string[] = []
  for (let y = 0; y < sprite.length; y += 2) {
    const top = sprite[y]
    const bot = sprite[y + 1] ?? Array(top.length).fill(0)
    let line = fg
    for (let x = 0; x < top.length; x++) {
      const t = top[x]
      const b = bot[x]
      if (t && b) line += '█'
      else if (t) line += '▀'
      else if (b) line += '▄'
      else line += ' '
    }
    line += RESET
    lines.push(line)
  }
  return lines
}

// ── Sparkline ──────────────────────────────────────────────────────────

const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

function sparkline(values: number[], width: number): string {
  if (values.length === 0) return ' '.repeat(width)
  const slice = values.slice(-width)
  const padded = Array(Math.max(0, width - slice.length)).fill(0).concat(slice)
  const max = Math.max(1, ...padded)
  return padded
    .map(v => {
      if (v === 0) return ' '
      const idx = Math.min(SPARK_GLYPHS.length - 1, Math.floor((v / max) * (SPARK_GLYPHS.length - 1)))
      return SPARK_GLYPHS[idx]
    })
    .join('')
}

// ── Connection management ─────────────────────────────────────────────

function connectNode(state: NodeState, secret: string): void {
  state.status = 'connecting'
  state.lastError = undefined

  const lib = state.protocol === 'https' ? https : http
  const url = `${state.protocol}://${state.host}/events`

  const req = lib.request(
    url,
    {
      method: 'GET',
      headers: { 'X-Intercom-Secret': secret, Accept: 'text/event-stream' },
    },
    (res) => {
      if (res.statusCode !== 200) {
        state.status = 'error'
        state.lastError = `HTTP ${res.statusCode}`
        res.resume()
        scheduleReconnect(state, secret)
        return
      }

      state.status = 'connected'
      res.setEncoding('utf8')

      let buffer = ''
      res.on('data', (chunk: string) => {
        buffer += chunk
        let sep
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const json = line.slice(6)
            try {
              const ev = JSON.parse(json) as ActivityEvent
              if (ev && (ev.type === 'send' || ev.type === 'recv')) ingestEvent(state, ev)
            } catch {
              // Ignore non-event frames (hello, comments, etc.)
            }
          }
        }
      })
      res.on('end', () => {
        state.status = 'error'
        state.lastError = 'stream ended'
        scheduleReconnect(state, secret)
      })
      res.on('error', (err) => {
        state.status = 'error'
        state.lastError = err.message
        scheduleReconnect(state, secret)
      })
    },
  )
  req.on('error', (err) => {
    state.status = 'error'
    state.lastError = err.message
    scheduleReconnect(state, secret)
  })
  req.end()
}

function scheduleReconnect(state: NodeState, secret: string): void {
  setTimeout(() => connectNode(state, secret), RECONNECT_DELAY_MS).unref?.()
}

function ingestEvent(state: NodeState, ev: ActivityEvent): void {
  state.events.push(ev)
  if (state.events.length > NODE_EVENT_BUFFER) state.events.shift()

  if (ev.type === 'send') state.sentTotal++
  else state.recvTotal++

  const ts = Date.parse(ev.timestamp)
  state.lastEventAt = Number.isFinite(ts) ? ts : Date.now()
  state.lastEventType = ev.type

  const sec = Math.floor(state.lastEventAt / 1000)
  state.buckets.set(sec, (state.buckets.get(sec) ?? 0) + 1)
  // Drop buckets older than SPARK_SECONDS to keep memory bounded.
  const cutoff = sec - SPARK_SECONDS
  for (const k of state.buckets.keys()) if (k < cutoff) state.buckets.delete(k)
}

function bucketsToSeries(state: NodeState, now: number): number[] {
  const nowSec = Math.floor(now / 1000)
  const out: number[] = []
  for (let i = SPARK_SECONDS - 1; i >= 0; i--) {
    out.push(state.buckets.get(nowSec - i) ?? 0)
  }
  return out
}

// ── Avatar selection ───────────────────────────────────────────────────

function pickAvatar(state: NodeState, frame: number, now: number): { sprite: Sprite; color: string; label: string } {
  if (state.status === 'connecting') {
    const sprite = frame % 6 < 3 ? SPRITE_CONNECTING : SPRITE_BLINK
    return { sprite, color: FG.yellow, label: 'connecting' }
  }
  if (state.status === 'error') {
    return { sprite: SPRITE_ERROR, color: FG.red, label: state.lastError ?? 'error' }
  }

  const since = now - state.lastEventAt
  if (state.lastEventAt && since < 1500) {
    if (state.lastEventType === 'send') {
      const sprite = frame % 4 < 2 ? SPRITE_TALK_A : SPRITE_TALK_B
      return { sprite, color: FG.green, label: 'sending' }
    }
    return { sprite: SPRITE_LISTEN, color: FG.cyan, label: 'receiving' }
  }

  // Idle: blink every ~2.5s (3 frames at 10fps).
  const sprite = frame % 25 === 0 ? SPRITE_BLINK : SPRITE_IDLE
  return { sprite, color: FG.gray, label: 'idle' }
}

// ── Layout ─────────────────────────────────────────────────────────────

const PANEL_WIDTH = 56
const PANEL_HEIGHT = 9 // border-included content height (rows between top/bottom border = PANEL_HEIGHT - 2)

function padRight(s: string, width: number): string {
  // Strips ANSI for length calculation but keeps escape codes.
  const visible = stripAnsi(s)
  if (visible.length >= width) return s
  return s + ' '.repeat(width - visible.length)
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s
  return s.slice(0, Math.max(0, width - 1)) + '…'
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

function buildPanel(state: NodeState, frame: number, now: number): string[] {
  const inner = PANEL_WIDTH - 2
  const { sprite, color, label } = pickAvatar(state, frame, now)
  const avatar = renderSprite(sprite, color) // 4 lines, 8 visual cols

  const statusDot =
    state.status === 'connected' ? `${FG.green}●${RESET}` :
    state.status === 'connecting' ? `${FG.yellow}●${RESET}` :
    `${FG.red}●${RESET}`

  const title = ` ${statusDot} ${BOLD}${state.name}${RESET} ${DIM}${state.host}${RESET} `
  const titlePadded = padRight(title, inner)

  const series = bucketsToSeries(state, now)
  const total = series.reduce((a, b) => a + b, 0)
  const spark = sparkline(series, 30)

  const recent = state.events.slice(-2)
  const lastLines = recent.length === 0
    ? [`${DIM}— no traffic yet —${RESET}`, '']
    : recent.map(e => {
        const arrow = e.type === 'send' ? `${FG.green}→${RESET}` : `${FG.cyan}←${RESET}`
        const who = e.type === 'send' ? `to ${e.peer}` : `from ${e.peer}`
        return `${arrow} ${DIM}${who}:${RESET} ${truncate(e.preview, inner - who.length - 6)}`
      })
  while (lastLines.length < 2) lastLines.push('')

  const stats = [
    `${DIM}status${RESET}  ${label}`,
    `${DIM}sent${RESET}    ${state.sentTotal}`,
    `${DIM}recv${RESET}    ${state.recvTotal}`,
    `${DIM}30s${RESET}     ${total} msg`,
  ]

  // Compose 4 avatar rows side-by-side with 4 stat rows.
  const body: string[] = []
  for (let i = 0; i < 4; i++) {
    const left = avatar[i] // exactly 8 visible chars
    const right = stats[i]
    body.push(`  ${left}   ${right}`)
  }

  // Sparkline + activity label
  const sparkLine = `  ${DIM}activity (last ${SPARK_SECONDS}s)${RESET}`
  const sparkVis = `  ${FG.magenta}${spark}${RESET}`

  const lines: string[] = []
  lines.push(`╭${'─'.repeat(inner)}╮`)
  lines.push(`│${titlePadded}│`)
  for (const row of body) lines.push(`│${padRight(row, inner)}│`)
  lines.push(`│${padRight(sparkLine, inner)}│`)
  lines.push(`│${padRight(sparkVis, inner)}│`)
  for (const row of lastLines) lines.push(`│${padRight('  ' + row, inner)}│`)
  lines.push(`╰${'─'.repeat(inner)}╯`)
  return lines
}

// ── Main render loop ──────────────────────────────────────────────────

let frame = 0
const states: NodeState[] = []

function render(): void {
  frame++
  const now = Date.now()
  const out: string[] = []

  out.push(CURSOR_HOME)
  const titleBar = `${BOLD}Claude Talkie-Walkie${RESET} ${DIM}· live dashboard · ${new Date(now).toLocaleTimeString()} · Ctrl-C to exit${RESET}`
  out.push(titleBar)
  out.push('')

  if (states.length === 0) {
    out.push(`${FG.yellow}No nodes configured.${RESET}`)
  } else {
    for (const state of states) {
      out.push(...buildPanel(state, frame, now))
      out.push('')
    }
  }

  out.push(CLEAR_BELOW)
  process.stdout.write(out.join('\n'))
}

// ── Entry point ───────────────────────────────────────────────────────

interface PeerSpec { name: string; host: string }

function parsePeerSpecs(args: string[]): PeerSpec[] {
  const collected: string[] = []
  for (const a of args) {
    // Accept both space-separated args and comma-separated bundles.
    for (const piece of a.split(',')) {
      const trimmed = piece.trim()
      if (trimmed) collected.push(trimmed)
    }
  }

  const specs: PeerSpec[] = []
  const seen = new Set<string>()
  for (const entry of collected) {
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      console.error(`[viewer] ignoring "${entry}" (expected name=host)`)
      continue
    }
    const name = entry.slice(0, eq).trim()
    const host = entry.slice(eq + 1).trim()
    if (!name || !host || seen.has(name)) continue
    seen.add(name)
    specs.push({ name, host })
  }
  return specs
}

export async function runViewer(argv: string[]): Promise<void> {
  const secret = process.env.INTERCOM_SECRET || 'change-me-in-production'

  let specs = parsePeerSpecs(argv)
  if (specs.length === 0 && process.env.PEERS) {
    specs = parsePeerSpecs([process.env.PEERS])
  }
  if (specs.length === 0 && process.env.MY_ROLE && process.env.INTERCOM_PORT) {
    specs.push({ name: process.env.MY_ROLE, host: `localhost:${process.env.INTERCOM_PORT}` })
  }

  if (specs.length === 0) {
    console.error('Usage: claude-talkie-walkie viewer <name>=<host> [<name>=<host>...]')
    console.error('   or: PEERS=name=host,... claude-talkie-walkie viewer')
    process.exit(1)
  }

  for (const { name, host } of specs) {
    const protocol: 'http' | 'https' = host.includes('ngrok') || host.includes('https') ? 'https' : 'http'
    const state: NodeState = {
      name,
      host,
      protocol,
      status: 'connecting',
      events: [],
      sentTotal: 0,
      recvTotal: 0,
      buckets: new Map(),
      lastEventAt: 0,
    }
    states.push(state)
    connectNode(state, secret)
  }

  // Enter alt-screen so we don't trash the user's scrollback.
  process.stdout.write(ALT_SCREEN_ON)
  process.stdout.write(HIDE_CURSOR)
  process.stdout.write(`${ESC}2J`)

  const restore = () => {
    process.stdout.write(SHOW_CURSOR)
    process.stdout.write(RESET)
    process.stdout.write(ALT_SCREEN_OFF)
  }
  process.on('SIGINT', () => { restore(); process.exit(0) })
  process.on('SIGTERM', () => { restore(); process.exit(0) })
  process.on('exit', restore)

  setInterval(render, FRAME_INTERVAL_MS).unref?.()

  // Keep the event loop alive forever (until SIGINT).
  await new Promise<void>(() => {})
}
