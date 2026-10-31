# 📒 OpenRemote

Lightweight, database-driven remote monitoring & interaction for local OpenCode agents.
No hosted backend — a Supabase project (Postgres + Realtime + Storage) is the sync layer; a tiny local worker bridges your machine; a scrapbook-styled web app is your remote window.

```
┌─────────────┐   SSE/REST    ┌──────────────┐   Postgres/Realtime   ┌──────────┐
│ OpenCode    │◄─────────────►│ openremote   │◄─────────────────────►│ Supabase │
│ (local)     │               │ worker (CLI) │                       └────▲─────┘
└─────────────┘               └──────────────┘                            │
                                                              ┌──────────┴─────────┐
                                                              │ web app (mobile)   │
                                                              └────────────────────┘
```

## Pieces

| Path        | What                                                       |
| ----------- | ---------------------------------------------------------- |
| `plugin/`   | `openremote` CLI + persistent worker (start/stop/status/pair) |
| `web/`      | React + Vite front end — paper-notebook UI, realtime feed    |
| `supabase/` | `schema.sql` — tables, RLS, pairing RPC, storage bucket      |
| `plugin/src/tui.ts` | native `/opencode-remote` TUI command (zero LLM)          |

## Setup

**Friends / everyday machines** (one line):

```bash
curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash
```

Then: `opencode serve` in your project → `openremote start` in another terminal → enter the printed pairing code at https://openremote-link.vercel.app.

**Owners** (host your own):
1. Supabase project → run `supabase/schema.sql`; turn OFF email confirmations (Auth → Providers → Email) so users can self-pair.
2. Deploy `web/` anywhere static (Vercel: root dir `web`, env `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`).
3. Edit `install.sh` defaults (or ship env overrides) with your project's URL + publishable key.

## Commands

```
openremote start             start the local worker (idempotent — one worker only)
openremote stop              stop worker, mark sessions offline
openremote status            worker + session state
openremote code              mint a fresh pairing code for the web app
openremote pair <CODE>       pair with a code minted elsewhere
openremote config ...        set URL/keys/server
openremote install           install CLI wrapper + register the native slash command
```

/opencode-remote (alias /or) is a native TUI plugin command — it runs the CLI locally and shows the result in a toast, no LLM turn involved. It opens a small menu: start / stop / status / pairing code.

## Data lifecycle

- Worker sweeps hourly: events older than `retention_days` (default 7) and completed/failed prompts + their storage objects older than the window are removed.
- **Pending / processing prompts are never deleted.**
- Web app: per-session wipe + manual clears in Settings.

## Design

Digital scrapbook: warm paper grain, sticky notes, masking tape, handwritten headings (Caveat) over monospace body (Space Mono), pastel palette, torn-note corners. Every screen, same aesthetic.
