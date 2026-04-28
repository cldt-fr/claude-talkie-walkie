# Claude Talkie-Walkie

N-way communication bridge between Claude Code sessions using the [Channels API](https://code.claude.com/docs/en/channels-reference).

Let multiple Claude Code instances on different machines talk to each other in real-time — no cloning, no setup, just `npx`.

## Why?

Developers running Claude Code on separate machines currently have to relay questions through Slack or copy-paste. Claude Talkie-Walkie creates a direct hotline between the AI sessions — one Claude can ask another about endpoints, schemas, or implementation details and get answers from the actual codebase.

Since v2, you can connect more than two instances. A typical setup:

- a **backend** Claude that knows the API,
- a **frontend** Claude that builds the UI,
- a **tester** Claude wired to a real browser (e.g. via [`claude-in-chrome`](https://www.npmjs.com/package/claude-in-chrome)) that exercises the running app and reports back.

## Quick Start

### 1. Configure

Add this to your project's `.mcp.json` on **every machine**. Each instance lists its peers in `PEERS` as `name=host,name=host`.

**Backend machine:**

```json
{
  "mcpServers": {
    "talkie-walkie": {
      "command": "npx",
      "args": ["-y", "claude-talkie-walkie"],
      "env": {
        "MY_ROLE": "backend",
        "PEERS": "frontend=10.0.0.5:8788,tester=10.0.0.7:8788",
        "INTERCOM_SECRET": "your-shared-secret",
        "INTERCOM_PORT": "8788"
      }
    }
  }
}
```

**Frontend machine:**

```json
{
  "mcpServers": {
    "talkie-walkie": {
      "command": "npx",
      "args": ["-y", "claude-talkie-walkie"],
      "env": {
        "MY_ROLE": "frontend",
        "PEERS": "backend=10.0.0.6:8788,tester=10.0.0.7:8788",
        "INTERCOM_SECRET": "your-shared-secret",
        "INTERCOM_PORT": "8788"
      }
    }
  }
}
```

**Tester machine** (also has the Chrome MCP so its Claude can drive a browser):

```json
{
  "mcpServers": {
    "talkie-walkie": {
      "command": "npx",
      "args": ["-y", "claude-talkie-walkie"],
      "env": {
        "MY_ROLE": "tester",
        "PEERS": "backend=10.0.0.6:8788,frontend=10.0.0.5:8788",
        "INTERCOM_SECRET": "your-shared-secret",
        "INTERCOM_PORT": "8788"
      }
    },
    "claude-in-chrome": {
      "command": "npx",
      "args": ["-y", "claude-in-chrome"]
    }
  }
}
```

### 2. Start

On **every machine**:

```bash
claude --dangerously-load-development-channels server:talkie-walkie
```

### 3. Talk

In any Claude Code session:

> "Ask the tester to verify the login flow works against the staging URL."

Claude will use `send_message({ to: "tester", message: "..." })`. The tester Claude receives it as a channel notification, drives Chrome to test, and replies via `send_message({ to: "frontend", message: "..." })`.

## Tools exposed to Claude

| Tool | Arguments | Description |
|------|-----------|-------------|
| `send_message` | `{ to, message }` | Send a message to one peer by name. |
| `broadcast_message` | `{ message, exclude? }` | Send the same message to every peer (optionally skipping some). |
| `list_peers` | — | List the peers reachable from this machine. |

## Live open-space dashboard

Each instance exposes a Server-Sent Events stream on `GET /events` (auth: same `X-Intercom-Secret` header). The package ships with a viewer subcommand that subscribes to every node you give it and renders them as a single shared open-space office in your terminal:

```bash
INTERCOM_SECRET=your-shared-secret \
  npx claude-talkie-walkie viewer \
  backend=10.0.0.6:8788 \
  frontend=10.0.0.5:8788 \
  tester=10.0.0.7:8788
```

You can also drop the args and reuse the env you already set for the MCP server — the viewer reads `PEERS` and `INTERCOM_SECRET` from the environment:

```bash
PEERS="backend=10.0.0.6:8788,frontend=10.0.0.5:8788,tester=10.0.0.7:8788" \
INTERCOM_SECRET=your-shared-secret \
  npx claude-talkie-walkie viewer
```

Every peer sits at a desk in the same room. When one Claude sends a message, a speech bubble pops above the speaker, an arrow travels along the floor toward the recipient, and the recipient's avatar turns to listen. A chat feed under the room shows the running conversation across all instances (deduped — you see each logical message once even when both endpoints are watched).

```
╔══════◉═════════════◉═════════════◉═════════════◉════════╗
║                     ╭──────────────╮                    ║
║                     │ check the l… │                    ║
║                     ╰───────┬──────╯                    ║
║                             ╵                           ║
║       ▄████▄             ▄████▄            ▄████▄█      ║
║      ██▄██▄██           ██▄██▄██          ██▄██▄██      ║
║      ██▀██▀██           ███  ███          ██▀██▀██      ║
║       ▀████▀             ▀████▀            ▀████▀       ║
║     ▔▔▔▔▔▔▔▔▔▔         ▔▔▔▔▔▔▔▔▔▔        ▔▔▔▔▔▔▔▔▔▔     ║
║      ╵      ╵           ╵      ╵          ╵      ╵      ║
║      ● backend         ● frontend         ● tester      ║
║        idle              talking          listening     ║
║ · ╌ · ╌ · ╌ · ╌ · ╌ · ╌ · ╌ · ╌ · ╌ ·⋅·▶· ╌ · ╌ · ╌ · ╌·║
╚═════════════════════════════════════════════════════════╝

─── chat ───────────────────────────────────────────────────
14:32:15  frontend → backend: what API endpoints exist for /users?
14:32:16  backend  → frontend: GET /api/users returns paginated list
14:32:17  frontend → tester:   check the login flow on staging
```

Avatar moods:
- `idle` (gray) — no recent activity, occasional blink
- `talking` (green) — just sent a message; mouth animates
- `listening` (cyan) — just received a message; ear pokes out
- `connecting` (yellow) — handshake in progress, auto-retries every 3s
- `offline` (red, X-eyes) — auth failed or peer unreachable

The viewer uses an alt-screen so it doesn't clobber your terminal scrollback — Ctrl-C exits cleanly.

## Architecture

```
       Backend                 Frontend                Tester
  (10.0.0.6)              (10.0.0.5)              (10.0.0.7)
  Claude Code             Claude Code             Claude Code
       |                        |                       |
       +-- talkie-walkie -------+-- talkie-walkie ------+
                       (HTTP POST /message, X-Intercom-Secret)
```

Every instance runs the same MCP server. It listens for HTTP messages and pushes them into its local Claude Code session via the Channels API. It also exposes `send_message` / `broadcast_message` / `list_peers` tools so Claude can reach any peer by name.

The mesh is symmetric — there is no central hub. Each machine just needs to be able to reach every peer it wants to talk to.

## Behind NAT / No Public IP?

If a machine is behind a router, use [ngrok](https://ngrok.com):

```bash
ngrok http 8788
```

Then put the ngrok URL in the other machines' `PEERS` for that name:

```text
PEERS=backend=your-subdomain.ngrok-free.app,tester=10.0.0.7:8788
```

The server auto-detects ngrok URLs and switches to HTTPS.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MY_ROLE` | `developer-a` | Label for this instance — appears as the sender role on outgoing messages. |
| `PEERS` | _(empty)_ | Comma-separated list of `name=host` pairs. Each name is what other Claudes will use to reach this peer. |
| `REMOTE_HOST` | _(empty)_ | **Legacy.** If set and `PEERS` is empty, registers a single peer named `remote`. Prefer `PEERS`. |
| `INTERCOM_SECRET` | `change-me-in-production` | Shared secret — must match on every machine. |
| `INTERCOM_PORT` | `8788` | Port to listen on for incoming messages. |

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Returns `{"status":"ok","role":"...","peers":[...]}` |
| `POST` | `/message` | `X-Intercom-Secret` header | Pushes a message into Claude's session |
| `GET` | `/events` | `X-Intercom-Secret` header | SSE stream of send/recv activity (used by the viewer) |

## Security

- **Shared secret**: every message requires an `X-Intercom-Secret` header. Requests without it get `401 Unauthorized`.
- **No persistence**: messages are forwarded in real-time and never stored.

> **Warning**: use a strong secret. Anyone who knows your IP and secret can inject messages into your Claude session.

## Use Cases

- **Backend + Frontend collaboration**: backend Claude answers API questions from frontend Claude using the actual codebase.
- **Live testing loop**: a tester Claude with browser automation runs the feature your frontend Claude just shipped, and reports issues back.
- **Monorepo with split teams**: different Claude sessions working on different packages can coordinate.
- **Code review relay**: one Claude reviews code and sends findings to the author's Claude.
- **CI/CD notifications**: point your CI webhook at `/message` with the right secret to push build results into a Claude session.

## Migrating from v1

v1 used a single `REMOTE_HOST` and a 1-arg `send_message({ message })`. v2 keeps `REMOTE_HOST` as a fallback (registered as a peer named `remote`), but new tools take a `to` parameter. To upgrade: replace `REMOTE_HOST=…` with `PEERS=name=…` everywhere, set a `MY_ROLE` per machine, and you're done.

## Requirements

- [Claude Code](https://claude.ai/claude-code) v2.1.80+
- Node.js 20+

## License

MIT
