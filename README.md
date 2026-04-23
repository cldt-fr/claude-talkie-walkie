# Claude Talkie-Walkie

Two-way communication bridge between Claude Code sessions using the [Channels API](https://code.claude.com/docs/en/channels-reference).

Let two Claude Code instances on different machines talk to each other in real-time — no cloning, no setup, just `npx`.

## Why?

Two developers running Claude Code on separate machines currently have to relay questions through Slack or copy-paste. Claude Talkie-Walkie creates a direct hotline between the two AI sessions — one Claude can ask the other about endpoints, schemas, or implementation details and get answers from the actual codebase.

## Quick Start

### 1. Configure

Add this to your project's `.mcp.json` on **both machines**:

**Machine A** (e.g. backend):

```json
{
  "mcpServers": {
    "talkie-walkie": {
      "command": "npx",
      "args": ["-y", "claude-talkie-walkie"],
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

**Machine B** (e.g. frontend):

```json
{
  "mcpServers": {
    "talkie-walkie": {
      "command": "npx",
      "args": ["-y", "claude-talkie-walkie"],
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

### 2. Start

On **both machines**:

```bash
claude --dangerously-load-development-channels server:talkie-walkie
```

### 3. Talk

In either Claude Code session:

> "Send a message to the other developer asking what API endpoints are available for the dashboard."

Claude will use the `send_message` tool to reach the other machine. The other Claude receives it as a channel notification and responds.

## Architecture

```
Machine A                          Machine B
(e.g. backend dev)                 (e.g. frontend dev)

Claude Code A                      Claude Code B
     |                                  |
     +-- talkie-walkie --HTTP POST---> talkie-walkie --+
     |   (channel)      <--HTTP POST-- (channel)       |
     |                                                 |
     +-- stdio (MCP) --+        +-- stdio (MCP) -------+
                        |        |
                   Claude A    Claude B
```

Both instances run the same server. Each listens for HTTP messages and pushes them into its local Claude Code session via the Channels API. Each also exposes a `send_message` tool that Claude can call to reach the other machine.

## Behind NAT / No Public IP?

If one machine is behind a router, use [ngrok](https://ngrok.com):

```bash
ngrok http 8788
```

Then set the other machine's `REMOTE_HOST` to the ngrok URL:

```json
"REMOTE_HOST": "your-subdomain.ngrok-free.app"
```

The server auto-detects ngrok URLs and switches to HTTPS.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MY_ROLE` | `developer-a` | Label for this instance (appears in messages) |
| `REMOTE_HOST` | `localhost:8789` | Address of the other machine (`IP:port` or ngrok URL) |
| `INTERCOM_SECRET` | `change-me-in-production` | Shared secret — must match on both sides |
| `INTERCOM_PORT` | `8788` | Port to listen on for incoming messages |

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Returns `{"status":"ok","role":"..."}` |
| `POST` | `/message` | `X-Intercom-Secret` header | Pushes a message into Claude's session |

## Security

- **Shared secret**: Every message requires an `X-Intercom-Secret` header. Requests without it get `401 Unauthorized`.
- **No persistence**: Messages are forwarded in real-time and never stored.

> **Warning**: Use a strong secret. Anyone who knows your IP and secret can inject messages into your Claude session.

## Use Cases

- **Backend + Frontend collaboration**: Backend Claude answers API questions from frontend Claude using the actual codebase
- **Monorepo with split teams**: Different Claude sessions working on different packages can coordinate
- **Code review relay**: One Claude reviews code and sends findings to the author's Claude
- **CI/CD notifications**: Point your CI webhook at the server to push build results into a Claude session

## Requirements

- [Claude Code](https://claude.ai/claude-code) v2.1.80+
- Node.js 20+

## License

MIT
