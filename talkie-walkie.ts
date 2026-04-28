#!/usr/bin/env node
/**
 * Claude Talkie-Walkie - N-way bridge between Claude Code sessions
 *
 * Enables real-time communication between multiple Claude Code instances
 * running on different machines using the Channels API.
 *
 * Architecture (mesh, peer-to-peer):
 *   Each instance lists its peers in the PEERS env var (name=host,...).
 *   send_message({ to, message })       targets one peer by name.
 *   broadcast_message({ message })      fans out to every known peer.
 *   list_peers()                        returns the known peer names.
 *
 * @requires Claude Code v2.1.80+
 * @requires @modelcontextprotocol/sdk
 * @see https://code.claude.com/docs/en/channels-reference
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { runViewer } from './viewer.js'

// ── Subcommand dispatch ────────────────────────────────────────────────
// `claude-talkie-walkie viewer …` → live dashboard (no MCP server).
// Anything else (or no args) → MCP server.

if (process.argv[2] === 'viewer') {
  await runViewer(process.argv.slice(3))
  process.exit(0)
}

// ── Configuration ──────────────────────────────────────────────────────
// All config via environment variables — no hardcoded values.

/** Shared secret for authenticating messages between instances */
const SECRET = process.env.INTERCOM_SECRET || 'change-me-in-production'

/** This instance's role — appears in message tags so Claude knows who's talking */
const MY_ROLE = process.env.MY_ROLE || 'developer-a'

/** Port to listen on for incoming messages */
const PORT = parseInt(process.env.INTERCOM_PORT || '8788', 10)

/**
 * Peer registry: name -> host.
 *
 * Format: PEERS="frontend=10.0.0.5:8788,backend=10.0.0.6:8788,tester=10.0.0.7:8788"
 *
 * Backward compatibility: if PEERS is unset and the legacy REMOTE_HOST is
 * present, we register a single peer named "remote" pointing to it.
 */
function parsePeers(raw: string): Map<string, string> {
  const peers = new Map<string, string>()
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=')
    if (eq < 0) {
      console.error(`[talkie-walkie] ignoring malformed PEERS entry "${entry}" (expected name=host)`)
      continue
    }
    const name = entry.slice(0, eq).trim()
    const host = entry.slice(eq + 1).trim()
    if (!name || !host) {
      console.error(`[talkie-walkie] ignoring malformed PEERS entry "${entry}"`)
      continue
    }
    if (name === MY_ROLE) {
      console.error(`[talkie-walkie] ignoring peer "${name}" — matches MY_ROLE (would send to self)`)
      continue
    }
    peers.set(name, host)
  }
  return peers
}

const PEERS = parsePeers(process.env.PEERS || '')
if (PEERS.size === 0 && process.env.REMOTE_HOST) {
  PEERS.set('remote', process.env.REMOTE_HOST)
}

const peerListForPrompt = PEERS.size
  ? [...PEERS.keys()].map(n => `"${n}"`).join(', ')
  : '(none configured)'

// ── Event tracking ─────────────────────────────────────────────────────
// In-memory ring buffer of recent send/recv events, plus a set of
// connected SSE clients (the viewer). Both are local to this process —
// the viewer subscribes per-host and aggregates them itself.

interface ActivityEvent {
  type: 'send' | 'recv'
  /** For 'send': target peer name. For 'recv': sender role. */
  peer: string
  /** Truncated single-line preview of the message. */
  preview: string
  timestamp: string
}

const EVENT_BUFFER_MAX = 100
const eventBuffer: ActivityEvent[] = []
const sseClients = new Set<ServerResponse>()

function previewMessage(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? flat.slice(0, 117) + '…' : flat
}

function recordEvent(ev: ActivityEvent): void {
  eventBuffer.push(ev)
  if (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.shift()

  const payload = `data: ${JSON.stringify(ev)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(payload)
    } catch {
      sseClients.delete(client)
    }
  }
}

// ── MCP Server Setup ───────────────────────────────────────────────────
// The `claude/channel` experimental capability is what makes this a Channel
// rather than a regular MCP server. Claude Code registers a notification
// listener for it and surfaces incoming events in the conversation.

const mcp = new Server(
  { name: 'talkie-walkie', version: '2.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      `You are "${MY_ROLE}". Other Claude Code instances reachable from here: ${peerListForPrompt}.`,
      `Incoming messages arrive as <channel source="talkie-walkie" role="<sender>" ...>content</channel>.`,
      '',
      'When you receive a message:',
      '- Read it carefully and respond helpfully',
      '- Reply with send_message({ to: "<sender>", message: "..." })',
      '- Check your codebase before answering if needed — don\'t guess',
      '',
      'When YOU need to reach another instance:',
      '- send_message({ to, message }) for a single peer',
      '- broadcast_message({ message }) to fan out to everyone',
      '- list_peers() if you forgot who is reachable',
      '',
      'Keep responses focused and technical. Include code, endpoints, or file paths when relevant.',
    ].join('\n'),
  },
)

// ── Tools ──────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description:
        'Send a message to a specific peer Claude Code instance. ' +
        'Use this to reply to an incoming channel message or to initiate a conversation. ' +
        `Known peers: ${peerListForPrompt}.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description: 'Name of the peer to send to (must match a configured peer name).',
          },
          message: {
            type: 'string',
            description: 'The message to send.',
          },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'broadcast_message',
      description:
        'Send the same message to every configured peer at once. ' +
        'Useful for announcements ("deploy starting"), questions to the whole team, ' +
        'or coordinating multi-instance work.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'The message to broadcast.',
          },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of peer names to skip.',
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'list_peers',
      description: 'List the peer Claude Code instances reachable from this machine.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}))

/** Send a message to one peer. Returns ok=true on 2xx, otherwise an error string. */
async function sendToPeer(name: string, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const host = PEERS.get(name)
  if (!host) {
    const known = [...PEERS.keys()].join(', ') || '(none)'
    return { ok: false, error: `Unknown peer "${name}". Known peers: ${known}` }
  }

  // Auto-detect protocol: ngrok URLs need HTTPS, direct IPs use HTTP
  const protocol = host.includes('ngrok') || host.includes('https') ? 'https' : 'http'

  try {
    const resp = await fetch(`${protocol}://${host}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Intercom-Secret': SECRET,
      },
      body: JSON.stringify({
        content: message,
        role: MY_ROLE,
        timestamp: new Date().toISOString(),
      }),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      return { ok: false, error: `HTTP ${resp.status}: ${errText}` }
    }
    recordEvent({
      type: 'send',
      peer: name,
      preview: previewMessage(message),
      timestamp: new Date().toISOString(),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'send_message') {
    const { to, message } = req.params.arguments as { to: string; message: string }
    const result = await sendToPeer(to, message)
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to send to "${to}": ${result.error}` }],
        isError: true,
      }
    }
    return {
      content: [{ type: 'text' as const, text: `Message sent to "${to}".` }],
    }
  }

  if (req.params.name === 'broadcast_message') {
    const { message, exclude } = req.params.arguments as { message: string; exclude?: string[] }
    const skip = new Set(exclude ?? [])
    const targets = [...PEERS.keys()].filter(n => !skip.has(n))

    if (targets.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No peers to broadcast to.' }],
        isError: true,
      }
    }

    const results = await Promise.all(
      targets.map(async name => ({ name, result: await sendToPeer(name, message) })),
    )

    const ok = results.filter(r => r.result.ok).map(r => r.name)
    const failed = results.filter(r => !r.result.ok) as { name: string; result: { ok: false; error: string } }[]

    const lines: string[] = []
    if (ok.length) lines.push(`Sent to: ${ok.join(', ')}`)
    for (const f of failed) lines.push(`Failed for "${f.name}": ${f.result.error}`)

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      isError: failed.length > 0 && ok.length === 0,
    }
  }

  if (req.params.name === 'list_peers') {
    if (PEERS.size === 0) {
      return { content: [{ type: 'text' as const, text: 'No peers configured.' }] }
    }
    const lines = [...PEERS.entries()].map(([name, host]) => `- ${name} → ${host}`)
    return {
      content: [{ type: 'text' as const, text: `Known peers (${PEERS.size}):\n${lines.join('\n')}` }],
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`)
})

// ── Connect to Claude Code ─────────────────────────────────────────────
// Claude Code spawns this process and communicates over stdin/stdout.

await mcp.connect(new StdioServerTransport())

// ── HTTP Listener ──────────────────────────────────────────────────────
// Receives messages from peer machines and pushes them into the local
// Claude Code session as channel notifications.

/** Read the full request body as a string */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

/** Send a JSON response */
function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  // Health check — useful for verifying the tunnel/connection
  if (req.method === 'GET' && url.pathname === '/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      role: MY_ROLE,
      version: '2.0.0',
      peers: [...PEERS.keys()],
    })
    return
  }

  // Message endpoint — receives messages from peers
  if (req.method === 'POST' && url.pathname === '/message') {
    // Authenticate: reject messages without the correct shared secret
    const token = req.headers['x-intercom-secret']
    if (token !== SECRET) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }

    const body = await readBody(req)
    const data = JSON.parse(body) as {
      content: string
      role: string
      timestamp: string
    }

    // Push the message into Claude's conversation as a channel event.
    // It appears as: <channel source="talkie-walkie" role="..." timestamp="...">content</channel>
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: data.content,
        meta: {
          role: data.role,
          timestamp: data.timestamp,
        },
      },
    })

    recordEvent({
      type: 'recv',
      peer: data.role,
      preview: previewMessage(data.content),
      timestamp: data.timestamp,
    })

    res.writeHead(200)
    res.end('ok')
    return
  }

  // Live event stream — the viewer subscribes here. Auth same as /message.
  if (req.method === 'GET' && url.pathname === '/events') {
    const token = req.headers['x-intercom-secret']
    if (token !== SECRET) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Greeting frame so the client can confirm the role/version.
    res.write(`event: hello\ndata: ${JSON.stringify({ role: MY_ROLE, version: '2.0.0' })}\n\n`)
    // Replay buffered events so the viewer warms up immediately.
    for (const ev of eventBuffer) res.write(`data: ${JSON.stringify(ev)}\n\n`)

    sseClients.add(res)

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* dropped on next write */ }
    }, 15000)

    const cleanup = () => {
      clearInterval(heartbeat)
      sseClients.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

httpServer.listen(PORT, '0.0.0.0')

console.error(`[talkie-walkie] ${MY_ROLE} listening on port ${PORT}`)
console.error(`[talkie-walkie] Peers: ${peerListForPrompt}`)
