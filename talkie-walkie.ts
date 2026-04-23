#!/usr/bin/env node
/**
 * Claude Intercom - Two-way bridge between Claude Code sessions
 *
 * Enables real-time communication between two Claude Code instances
 * running on different machines using the Channels API.
 *
 * Architecture:
 *   Machine A (e.g. backend dev)  <--HTTP-->  Machine B (e.g. frontend dev)
 *   Claude Code A                             Claude Code B
 *     |                                         |
 *     +-- intercom.ts (channel) ----------------+-- intercom.ts (channel)
 *         listens on :8788                          listens on :8788
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

// ── Configuration ──────────────────────────────────────────────────────
// All config via environment variables — no hardcoded values.

/** Shared secret for authenticating messages between instances */
const SECRET = process.env.INTERCOM_SECRET || 'change-me-in-production'

/** The remote machine's address (IP:port, hostname:port, or ngrok URL) */
const REMOTE_HOST = process.env.REMOTE_HOST || 'localhost:8789'

/** This instance's role — appears in message tags so Claude knows who's talking */
const MY_ROLE = process.env.MY_ROLE || 'developer-a'

/** Port to listen on for incoming messages */
const PORT = parseInt(process.env.INTERCOM_PORT || '8788', 10)

// ── MCP Server Setup ───────────────────────────────────────────────────
// The `claude/channel` experimental capability is what makes this a Channel
// rather than a regular MCP server. Claude Code registers a notification
// listener for it and surfaces incoming events in the conversation.

const mcp = new Server(
  { name: 'intercom', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      `You are ${MY_ROLE}. Messages from the other developer arrive as <channel source="intercom" role="..." ...>content</channel>.`,
      '',
      'When you receive a message:',
      '- Read it carefully and respond helpfully',
      '- Use the send_message tool to reply back',
      '- Check your codebase before answering if needed — don\'t guess',
      '',
      'When YOU need to ask the other developer something:',
      '- Use the send_message tool with your question',
      '',
      'Keep responses focused and technical. Include code, endpoints, or file paths when relevant.',
    ].join('\n'),
  },
)

// ── Reply Tool ─────────────────────────────────────────────────────────
// Claude calls this tool to send messages to the other instance.
// The tool makes an HTTP POST to the remote machine's intercom server.

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description:
        'Send a message to the other developer\'s Claude Code session. ' +
        'Use this to reply to incoming channel messages or to initiate a conversation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'The message to send',
          },
        },
        required: ['message'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'send_message') {
    const { message } = req.params.arguments as { message: string }

    try {
      // Auto-detect protocol: ngrok URLs need HTTPS, direct IPs use HTTP
      const protocol = REMOTE_HOST.includes('ngrok') || REMOTE_HOST.includes('https')
        ? 'https'
        : 'http'

      const resp = await fetch(`${protocol}://${REMOTE_HOST}/message`, {
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
        return {
          content: [{ type: 'text' as const, text: `Failed to send (${resp.status}): ${errText}` }],
          isError: true,
        }
      }

      return {
        content: [{ type: 'text' as const, text: `Message sent to the other developer.` }],
      }
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Connection failed: ${(err as Error).message}. Is the other machine running?`,
        }],
        isError: true,
      }
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`)
})

// ── Connect to Claude Code ─────────────────────────────────────────────
// Claude Code spawns this process and communicates over stdin/stdout.

await mcp.connect(new StdioServerTransport())

// ── HTTP Listener ──────────────────────────────────────────────────────
// Receives messages from the remote machine and pushes them into the
// local Claude Code session as channel notifications.

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
    jsonResponse(res, 200, { status: 'ok', role: MY_ROLE, version: '1.0.0' })
    return
  }

  // Message endpoint — receives messages from the other instance
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
    // It appears as: <channel source="intercom" role="..." timestamp="...">content</channel>
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

    res.writeHead(200)
    res.end('ok')
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

httpServer.listen(PORT, '0.0.0.0')

console.error(`[intercom] ${MY_ROLE} listening on port ${PORT}`)
console.error(`[intercom] Remote: ${REMOTE_HOST}`)
