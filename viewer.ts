/**
 * Claude Talkie-Walkie Viewer — open-space console dashboard.
 *
 * Connects to one or more talkie-walkie nodes via SSE (`GET /events`) and
 * renders a single shared "room": each peer sits at a desk with a pixel-art
 * avatar that animates with traffic, speech bubbles pop up above the
 * speakers, and messages travel as little arrows on the floor between
 * sender and recipient. A chat feed at the bottom shows the running
 * conversation.
 *
 * Usage:
 *   claude-talkie-walkie viewer name=host[,name=host…]   (CLI args)
 *   PEERS=name=host,… INTERCOM_SECRET=… claude-talkie-walkie viewer
 */
import * as http from 'node:http'
import * as https from 'node:https'

// ── Types ──────────────────────────────────────────────────────────────

interface ActivityEvent {
  type: 'send' | 'recv'
  peer: string
  preview: string
  timestamp: string
}

interface Bubble {
  text: string
  at: number
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
  /** Most recent send / recv timestamps in ms (used for avatar animation). */
  lastSendAt: number
  lastRecvAt: number
  bubble: Bubble | null
}

interface InFlight {
  fromIdx: number
  toIdx: number
  startedAt: number
}

interface ChatEntry {
  from: string
  to: string
  tsMs: number
  preview: string
}

// ── Tunables ───────────────────────────────────────────────────────────

const FRAME_INTERVAL_MS = 100
const FLIGHT_DURATION_MS = 1800
const BUBBLE_DURATION_MS = 3500
const ACTIVE_WINDOW_MS = 2500
const NODE_EVENT_BUFFER = 200
const RECONNECT_DELAY_MS = 3000
const CHAT_LOG_MAX = 200
const CHAT_DISPLAY_MAX = 6

// ── ANSI ───────────────────────────────────────────────────────────────

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

const ROLE_PALETTE = [FG.cyan, FG.magenta, FG.yellow, FG.green, FG.blue, FG.red] as const

// ── Sprites (8×8, top-down rows; 1 = lit) ──────────────────────────────

type Sprite = ReadonlyArray<ReadonlyArray<0 | 1>>

const SPRITE_IDLE: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_BLINK: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1],
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
  [1, 1, 0, 0, 0, 0, 1, 1],
  [1, 1, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_TALK_B: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 0, 0, 1, 1, 1],
  [1, 1, 1, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

const SPRITE_LISTEN: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 1],
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
  [1, 1, 1, 0, 0, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 0, 0, 1, 1, 1],
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

/** Render an 8-row sprite as a 4×8 grid of cells (each cell already colored). */
function renderSpriteCells(sprite: Sprite, color: string): string[][] {
  const rows: string[][] = []
  for (let y = 0; y < sprite.length; y += 2) {
    const top = sprite[y]
    const bot = sprite[y + 1] ?? Array(top.length).fill(0)
    const row: string[] = []
    for (let x = 0; x < top.length; x++) {
      const t = top[x]
      const b = bot[x]
      let ch = ' '
      if (t && b) ch = '█'
      else if (t) ch = '▀'
      else if (b) ch = '▄'
      row.push(ch === ' ' ? ' ' : color + ch + RESET)
    }
    rows.push(row)
  }
  return rows
}

// ── Canvas (2D grid of cells, each cell = one visible char ± ANSI) ─────

class Canvas {
  readonly width: number
  readonly height: number
  readonly cells: string[][]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: height }, () => Array(width).fill(' '))
  }

  set(x: number, y: number, ch: string): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return
    this.cells[y][x] = ch
  }

  setColored(x: number, y: number, ch: string, color: string): void {
    this.set(x, y, color + ch + RESET)
  }

  stampPlain(x: number, y: number, str: string, color?: string): void {
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      if (color && ch !== ' ') this.setColored(x + i, y, ch, color)
      else this.set(x + i, y, ch)
    }
  }

  stampCells(x: number, y: number, cells: string[][]): void {
    for (let dy = 0; dy < cells.length; dy++) {
      for (let dx = 0; dx < cells[dy].length; dx++) {
        const c = cells[dy][dx]
        if (c !== ' ') this.set(x + dx, y + dy, c)
      }
    }
  }

  toLines(): string[] {
    return this.cells.map(row => row.join(''))
  }
}

// ── Connection ─────────────────────────────────────────────────────────

const states: NodeState[] = []
const chatLog: ChatEntry[] = []
const chatSeen = new Set<string>()
const inFlight: InFlight[] = []
let frame = 0

function findStateIdx(name: string): number {
  return states.findIndex(s => s.name === name)
}

function colorForRole(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return ROLE_PALETTE[h % ROLE_PALETTE.length]
}

function ingestEvent(observer: NodeState, ev: ActivityEvent): void {
  observer.events.push(ev)
  if (observer.events.length > NODE_EVENT_BUFFER) observer.events.shift()
  if (ev.type === 'send') observer.sentTotal++
  else observer.recvTotal++

  const tsParsed = Date.parse(ev.timestamp)
  const tsMs = Number.isFinite(tsParsed) ? tsParsed : Date.now()

  // Resolve logical (from, to) regardless of which side observed it.
  const from = ev.type === 'send' ? observer.name : ev.peer
  const to = ev.type === 'send' ? ev.peer : observer.name

  // Dedupe (same logical message often observed twice — once on each end).
  const sec = Math.floor(tsMs / 1000)
  const key = `${from}>${to}@${sec}|${ev.preview}`
  if (chatSeen.has(key)) return
  chatSeen.add(key)

  // Update animation timestamps on both endpoints we know about.
  const fromIdx = findStateIdx(from)
  const toIdx = findStateIdx(to)
  if (fromIdx >= 0) {
    const s = states[fromIdx]
    if (tsMs > s.lastSendAt) s.lastSendAt = tsMs
    s.bubble = { text: ev.preview, at: Date.now() }
  }
  if (toIdx >= 0) {
    const s = states[toIdx]
    if (tsMs > s.lastRecvAt) s.lastRecvAt = tsMs
  }

  // In-flight animation only if we can place both endpoints.
  if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx && Date.now() - tsMs < 5000) {
    inFlight.push({ fromIdx, toIdx, startedAt: Date.now() })
  }

  chatLog.push({ from, to, tsMs, preview: ev.preview })
  if (chatLog.length > CHAT_LOG_MAX) chatLog.shift()
}

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
            try {
              const ev = JSON.parse(line.slice(6)) as ActivityEvent
              if (ev && (ev.type === 'send' || ev.type === 'recv')) ingestEvent(state, ev)
            } catch {
              // Non-event frames (hello, pings) are fine to skip.
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

// ── Avatar selection ──────────────────────────────────────────────────

function pickAvatar(state: NodeState, frame: number, now: number): { sprite: Sprite; color: string; mood: string } {
  if (state.status === 'connecting') {
    return { sprite: frame % 6 < 3 ? SPRITE_CONNECTING : SPRITE_BLINK, color: FG.yellow, mood: 'connecting' }
  }
  if (state.status === 'error') {
    return { sprite: SPRITE_ERROR, color: FG.red, mood: 'offline' }
  }

  const sinceSend = state.lastSendAt ? now - state.lastSendAt : Infinity
  const sinceRecv = state.lastRecvAt ? now - state.lastRecvAt : Infinity

  if (sinceSend < ACTIVE_WINDOW_MS && sinceSend <= sinceRecv) {
    return { sprite: frame % 4 < 2 ? SPRITE_TALK_A : SPRITE_TALK_B, color: FG.green, mood: 'talking' }
  }
  if (sinceRecv < ACTIVE_WINDOW_MS) {
    return { sprite: SPRITE_LISTEN, color: FG.cyan, mood: 'listening' }
  }
  return { sprite: frame % 30 === 0 ? SPRITE_BLINK : SPRITE_IDLE, color: FG.gray, mood: 'idle' }
}

// ── Drawing helpers ───────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function drawBubble(canvas: Canvas, cx: number, topY: number, text: string, maxWidth: number): void {
  // Layout: │ <content> │ — interior is content.length cells wide, no extra padding.
  const innerMax = Math.max(4, maxWidth - 4) // -2 borders, -2 visual breathing room
  const content = truncate(text, innerMax)
  const inner = content.length + 2 // 1 space of breathing room on each side
  const w = inner + 2

  let left = cx - Math.floor(w / 2)
  if (left < 1) left = 1
  if (left + w > canvas.width - 1) left = canvas.width - 1 - w

  const c = FG.white
  canvas.setColored(left, topY, '╭', c)
  for (let i = 1; i < w - 1; i++) canvas.setColored(left + i, topY, '─', c)
  canvas.setColored(left + w - 1, topY, '╮', c)

  canvas.setColored(left, topY + 1, '│', c)
  for (let i = 1; i < w - 1; i++) canvas.set(left + i, topY + 1, ' ')
  canvas.stampPlain(left + 2, topY + 1, content, c)
  canvas.setColored(left + w - 1, topY + 1, '│', c)

  canvas.setColored(left, topY + 2, '╰', c)
  for (let i = 1; i < w - 1; i++) {
    if (left + i === cx) canvas.setColored(left + i, topY + 2, '┬', c)
    else canvas.setColored(left + i, topY + 2, '─', c)
  }
  canvas.setColored(left + w - 1, topY + 2, '╯', c)
  canvas.setColored(cx, topY + 3, '╵', c)
}

function drawStation(
  canvas: Canvas,
  cx: number,
  state: NodeState,
  frame: number,
  now: number,
  showBubble: boolean,
  bubbleMaxWidth: number,
): void {
  if (showBubble && state.bubble && now - state.bubble.at < BUBBLE_DURATION_MS) {
    drawBubble(canvas, cx, 1, state.bubble.text, bubbleMaxWidth)
  }

  const avatar = pickAvatar(state, frame, now)
  const cells = renderSpriteCells(avatar.sprite, avatar.color)
  // Avatar is 4 rows × 8 cols, centered horizontally on cx, top at row 5.
  canvas.stampCells(cx - 4, 5, cells)

  // Desk: a 10-wide top edge under the avatar.
  const deskY = 9
  const deskColor = FG.yellow
  for (let dx = -5; dx <= 4; dx++) canvas.setColored(cx + dx, deskY, '▔', deskColor)
  // Chair / under-desk: just a thin underline so the floor pattern shows through.
  canvas.setColored(cx - 4, deskY + 1, '╵', DIM)
  canvas.setColored(cx + 3, deskY + 1, '╵', DIM)

  // Name + status dot, centered on cx, on the row just below the desk legs.
  const dotColor =
    state.status === 'connected' ? FG.green :
    state.status === 'connecting' ? FG.yellow :
    FG.red
  const roleColor = colorForRole(state.name)
  const label = `● ${state.name}`
  const startX = cx - Math.floor(label.length / 2)
  canvas.setColored(startX, 11, '●', dotColor)
  canvas.stampPlain(startX + 2, 11, state.name, roleColor)

  // Mood line under the name.
  const mood = avatar.mood
  const moodColor = avatar.mood === 'talking' ? FG.green : avatar.mood === 'listening' ? FG.cyan : avatar.mood === 'offline' ? FG.red : DIM
  const moodStartX = cx - Math.floor(mood.length / 2)
  canvas.stampPlain(moodStartX, 12, mood, moodColor)
}

// ── Render loop ───────────────────────────────────────────────────────

function renderOpenspace(): void {
  frame++
  const now = Date.now()

  // Drop expired in-flight messages.
  while (inFlight.length && now - inFlight[0].startedAt > FLIGHT_DURATION_MS) {
    inFlight.shift()
  }

  const cols = process.stdout.columns || 100
  const N = states.length

  // Room sizing: try to give every station ~16 cols, but stay within terminal.
  const desiredWidth = Math.max(60, N * 16 + 10)
  const roomWidth = Math.max(40, Math.min(cols - 2, desiredWidth))
  const roomHeight = 15

  const canvas = new Canvas(roomWidth, roomHeight)
  const wallColor = FG.cyan

  // Walls
  for (let x = 0; x < roomWidth; x++) {
    canvas.setColored(x, 0, '═', wallColor)
    canvas.setColored(x, roomHeight - 1, '═', wallColor)
  }
  for (let y = 0; y < roomHeight; y++) {
    canvas.setColored(0, y, '║', wallColor)
    canvas.setColored(roomWidth - 1, y, '║', wallColor)
  }
  canvas.setColored(0, 0, '╔', wallColor)
  canvas.setColored(roomWidth - 1, 0, '╗', wallColor)
  canvas.setColored(0, roomHeight - 1, '╚', wallColor)
  canvas.setColored(roomWidth - 1, roomHeight - 1, '╝', wallColor)

  // Subtle ceiling lights stamped onto the top wall.
  for (let x = 7; x < roomWidth - 7; x += 14) canvas.setColored(x, 0, '◉', FG.yellow)

  // Floor pattern (just inside the bottom wall) — also where in-flight arrows fly.
  const floorY = roomHeight - 2
  for (let x = 1; x < roomWidth - 1; x++) {
    const ch = (x % 4 === 2) ? '·' : (x % 4 === 0 ? '╌' : ' ')
    if (ch !== ' ') canvas.setColored(x, floorY, ch, FG.gray)
  }

  // Station centers, evenly distributed within the interior.
  const interiorLeft = 2
  const interiorRight = roomWidth - 3
  const interiorWidth = interiorRight - interiorLeft + 1
  const stationXs: number[] = []
  for (let i = 0; i < N; i++) {
    const cx = interiorLeft + Math.floor((interiorWidth * (i * 2 + 1)) / (N * 2))
    stationXs.push(cx)
  }

  // Draw stations. Decide bubble visibility per station — only show one
  // bubble per column slot at a time so they don't pile up.
  const slotWidth = N > 0 ? Math.floor(interiorWidth / N) : interiorWidth
  for (let i = 0; i < N; i++) {
    const cx = stationXs[i]
    const bubbleMax = Math.max(10, slotWidth - 2)
    drawStation(canvas, cx, states[i], frame, now, true, bubbleMax)
  }

  // In-flight arrows on the floor, between sender and receiver columns.
  for (const flight of inFlight) {
    const t = Math.min(1, (now - flight.startedAt) / FLIGHT_DURATION_MS)
    const x0 = stationXs[flight.fromIdx]
    const x1 = stationXs[flight.toIdx]
    if (x0 === undefined || x1 === undefined) continue
    const x = Math.round(x0 + (x1 - x0) * t)
    const arrow = x1 >= x0 ? '▶' : '◀'
    canvas.setColored(x, floorY, arrow, FG.yellow)
    // Trailing dots, fading behind the arrow.
    const trail = x1 >= x0 ? -1 : 1
    for (let k = 1; k <= 2; k++) {
      const tx = x + trail * k
      if (tx > 0 && tx < roomWidth - 1 && (tx - x0) * (x1 - x0) >= 0) {
        const cur = canvas.cells[floorY][tx]
        // Only overdraw if the floor pattern (or empty) is below.
        if (!cur.includes('▶') && !cur.includes('◀')) {
          canvas.setColored(tx, floorY, k === 1 ? '·' : '⋅', FG.yellow)
        }
      }
    }
  }

  // Compose output
  const out: string[] = []
  out.push(CURSOR_HOME)
  const titleLine = `${BOLD}Claude Talkie-Walkie${RESET}  ${DIM}· open space · ${new Date(now).toLocaleTimeString()} · ${describeStatus()} · Ctrl-C to exit${RESET}`
  out.push(titleLine)
  out.push('')
  for (const row of canvas.toLines()) out.push(row)
  out.push('')
  out.push(`${DIM}─── chat ${'─'.repeat(Math.max(0, roomWidth - 9))}${RESET}`)

  const recent = chatLog.slice(-CHAT_DISPLAY_MAX)
  const lineWidth = Math.max(40, cols - 2)
  for (let i = 0; i < CHAT_DISPLAY_MAX; i++) {
    if (i < recent.length) {
      const e = recent[i]
      const time = new Date(e.tsMs).toLocaleTimeString()
      const fromColor = colorForRole(e.from)
      const toColor = colorForRole(e.to)
      const prefix = `${DIM}${time}${RESET}  ${fromColor}${e.from}${RESET} ${DIM}→${RESET} ${toColor}${e.to}${RESET}: `
      const prefixVisibleLen = time.length + 2 + e.from.length + 1 + 1 + 1 + e.to.length + 2
      const room = Math.max(8, lineWidth - prefixVisibleLen)
      out.push(prefix + truncate(e.preview, room))
    } else {
      out.push('')
    }
  }

  out.push(CLEAR_BELOW)
  process.stdout.write(out.join('\n'))
}

function describeStatus(): string {
  if (states.length === 0) return 'no peers'
  const connected = states.filter(s => s.status === 'connected').length
  return `${connected}/${states.length} online`
}

// ── Entry point ───────────────────────────────────────────────────────

interface PeerSpec { name: string; host: string }

function parsePeerSpecs(args: string[]): PeerSpec[] {
  const collected: string[] = []
  for (const a of args) {
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
      lastSendAt: 0,
      lastRecvAt: 0,
      bubble: null,
    }
    states.push(state)
    connectNode(state, secret)
  }

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

  setInterval(renderOpenspace, FRAME_INTERVAL_MS).unref?.()

  await new Promise<void>(() => {})
}
