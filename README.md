# Claude Intercom

Two-way communication bridge between Claude Code sessions using the [Channels API](https://code.claude.com/docs/en/channels-reference).

Let two Claude Code instances on different machines talk to each other in real-time. One sends a message, the other receives it instantly as a channel notification and can reply back.

## Why?

If you have a backend developer and a frontend developer each running Claude Code on separate machines, they currently have to relay questions through Slack/Discord/copy-paste. Claude Intercom creates a direct hotline between the two AI sessions — one Claude can ask the other about endpoints, schemas, or implementation details and get answers from the actual codebase.

## Architecture

```
Machine A                          Machine B
(e.g. backend dev)                 (e.g. frontend dev)

Claude Code A                      Claude Code B
     |                                  |
     +-- intercom.ts ---HTTP POST----> intercom.ts --+
     |   (channel)     <--HTTP POST--  (channel)     |
     |                                               |
     +-- stdio (MCP) --+        +-- stdio (MCP) -----+
                        |        |
                   Claude A    Claude B
```

Both instances run the same `intercom.ts` file. Each listens for HTTP messages and pushes them into its local Claude Code session via the Channels API. Each also exposes a `send_message` tool that Claude can call to send messages to the other machine.

## Requirements

- [Claude Code](https://claude.ai/claude-code) v2.1.80 or later
- [Bun](https://bun.sh) runtime
- Both machines must be able to reach each other over HTTP (direct IP, VPN, or [ngrok](https://ngrok.com))

## Quick Start

### 1. Install

On **both machines**:

```bash
git clone https://github.com/MuhammadTalhaMT/claude-intercom.git
cd claude-intercom
bun install
```

### 2. Configure

Copy the example config into your project's `.mcp.json`:

**Machine A** (e.g. backend — static IP or VPS):

```json
{
  "mcpServers": {
    "intercom": {
      "command": "bun",
      "args": ["/path/to/claude-intercom/intercom.ts"],
      "env": {
        "MY_ROLE": "backend",
        "REMOTE_HOST": "MACHINE_B_IP:8788",
        "INTERCOM_SECRET": "your-shared-secret",
        "INTERCOM_PORT": "8788"
      }
    }
  }
}
```

**Machine B** (e.g. frontend — can be behind NAT):

```json
{
  "mcpServers": {
    "intercom": {
      "command": "bun",
      "args": ["/path/to/claude-intercom/intercom.ts"],
      "env": {
        "MY_ROLE": "frontend",
        "REMOTE_HOST": "MACHINE_A_IP:8788",
        "INTERCOM_SECRET": "your-shared-secret",
        "INTERCOM_PORT": "8788"
      }
    }
  }
}
```

### 3. Start

On **both machines**:

```bash
claude --dangerously-load-development-channels server:intercom
```

### 4. Talk

In either Claude Code session:

> "Send a message to the other developer asking what API endpoints are available for the dashboard."

Claude will use the `send_message` tool to POST the message to the other machine. The other Claude receives it as a channel notification and responds.

## Behind NAT / Dynamic IP?

If one machine is behind a router (home network, no public IP), use [ngrok](https://ngrok.com):

```bash
# On the machine behind NAT
ngrok http 8788
```

Then set the other machine's `REMOTE_HOST` to the ngrok URL:

```json
"REMOTE_HOST": "your-subdomain.ngrok-free.app"
```

The intercom auto-detects ngrok URLs and switches to HTTPS.

> **Tip:** ngrok's paid plan gives you a static subdomain that never changes, even after restart.

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `MY_ROLE` | Yes | `developer-a` | Label for this instance (appears in message tags) |
| `REMOTE_HOST` | Yes | `localhost:8789` | Address of the other machine (`IP:port` or ngrok URL) |
| `INTERCOM_SECRET` | Yes | `change-me-in-production` | Shared secret — must match on both sides |
| `INTERCOM_PORT` | No | `8788` | Port to listen on for incoming messages |

## How It Works

1. Claude Code spawns `intercom.ts` as a subprocess (MCP server over stdio)
2. The script declares `claude/channel` capability — this registers it as a Channel
3. It starts an HTTP server listening for incoming messages
4. When a message arrives (authenticated via shared secret), it calls `mcp.notification()` with `method: 'notifications/claude/channel'`
5. Claude Code surfaces the notification in the conversation as a `<channel>` tag
6. Claude reads it and can reply using the `send_message` tool, which POSTs to the remote machine

## Security

- **Shared secret authentication**: Every message requires an `X-Intercom-Secret` header matching the configured secret. Requests without it get a `401 Unauthorized`.
- **No data persistence**: Messages are forwarded in real-time and not stored.
- **Localhost binding optional**: By default listens on `0.0.0.0` for cross-machine access. Set to `127.0.0.1` if using a tunnel.

> **Warning**: Don't use a weak or default secret in production. Anyone who knows your IP and secret can inject messages into your Claude session.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Returns `{"status":"ok","role":"..."}` |
| `POST` | `/message` | `X-Intercom-Secret` header | Pushes message into Claude's session |

## Use Cases

- **Backend + Frontend collaboration**: Backend Claude answers API questions from frontend Claude using the actual codebase
- **Monorepo with split teams**: Different Claude sessions working on different packages can coordinate
- **Code review relay**: One Claude reviews code and sends findings to the author's Claude session
- **CI/CD notifications**: Point your CI webhook at the intercom to push build results into a Claude session

## License

MIT
