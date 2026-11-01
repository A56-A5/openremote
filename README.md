# 📒 OpenRemote

Lightweight, database-driven remote monitoring & control for local OpenCode agents.
No hosted backend, no passwords - a Supabase project (Postgres + Auth + Realtime) is the
rendezvous point; a tiny local worker bridges your machine with outbound-only connections;
a scrapbook-styled web app on your phone is the remote window.

```
┌─────────────┐   SSE / REST    ┌──────────────┐   HTTPS (outbound only)   ┌──────────┐
│ OpenCode    │◄───────────────►│ openremote   │◄────────────────────────►│ Supabase │
│ (local)     │                 │ worker (CLI) │   Postgres + Auth        └────▲─────┘
└─────────────┘                 └──────────────┘   + Realtime                     │
                                                          ┌──────────────────────┴───┐
                                                          │ web app (phone browser)  │
                                                          └──────────────────────────┘
```

## Pieces

| Path                  | What                                                          |
| --------------------- | ------------------------------------------------------------- |
| `plugin/`             | `openremote` CLI + persistent worker (connect/stop/status/code) |
| `plugin/src/tui.ts`   | native `/openremote` TUI command (aliases `/or` - zero LLM)   |
| `web/`                | React + Vite front end - paper-notebook UI, single websocket  |
| `supabase/migrations/`| `20261101000000_openremote_v2.sql` - schema, RLS, RPCs        |
| `supabase/tests/`     | `rls_test.sql` - RLS / RPC test suite (run in SQL editor)     |
| `test/`               | offline integration harness (mock OpenCode + fake Supabase)   |

## How pairing works (no passwords anywhere)

1. `openremote connect` → the worker signs in **anonymously** to Supabase and syncs your
   local sessions (7-day window, subsessions filtered out).
2. `openremote code` mints `XXXX-XXXX` (Crockford base32, 10 minutes, single use, bcrypt
   hash in the DB, throttled per-IP failures).
3. On your phone: pair tab → code → `claim_pairing` links your (also anonymous) browser
   account to that computer. Row-level security keeps notebooks separate - every row
   carries `owner_id`, viewers only see their owner's rows.

## Setup

**Friends / everyday machines** — two steps, that's it:

```bash
# 1. install (one line — clones, builds, configures, adds to PATH)
curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash

# 2. in OpenCode, run:
/openremote
# → automatically starts the bridge, immediately shows your 8-letter pairing code
# → on your phone: https://openremote-link.vercel.app → enter the code
```

That's it. No separate `connect` or `code` step needed. The `/openremote` (alias `/or`) native TUI
command handles everything: it starts the worker if it's not running, mints a pairing code
if no phone is linked yet, and shows your status in a dialog — **zero LLM turns**.

**Owners** (host your own):

1. Supabase project → SQL editor → run `supabase/migrations/20261101000000_openremote_v2.sql`
   (fresh project; one paste). Then run `supabase/tests/rls_test.sql` to verify the policies.
2. Authentication → Providers → enable **Anonymous sign-ins** (the machine and the phone each
   sign in anonymously). If your project enforces CAPTCHA (Turnstile/hCaptcha) on anonymous
   sign-in, disable it - the web app surfaces the error but cannot solve challenges.
3. Deploy `web/` anywhere static (Vercel: root dir `web`, env `VITE_SUPABASE_URL` +
   `VITE_SUPABASE_ANON_KEY`).
4. Point the installer at your project:

```bash
OPENREMOTE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
OPENREMOTE_SUPABASE_ANON_KEY=YOUR_ANON_KEY \
OPENREMOTE_WEB_URL=https://your-deployed-web-app.vercel.app \
curl -fsSL …/install.sh | bash
```

## Commands

```
openremote connect [--url U] [--key K] [--server U]   start the local worker
openremote stop                                       stop worker + managed serve
openremote status [--json]                            connection, sessions, viewers
openremote code                                       mint a pairing code (10 min, single use)
openremote unlink [viewer_id]                         revoke linked phone(s)
openremote config [--url U] [--key K] [--server U]    set config
openremote install                                    install CLI + /openremote TUI command
```

`/openremote` (alias `/or`) inside OpenCode is a native TUI plugin command - it runs the CLI
locally and shows the result in a dialog, **zero LLM turns**. It handles start/stop, fresh
pairing codes, unlink, and refresh; when unpaired it runs `connect` for you.

## Data lifecycle

- Worker sweeps hourly: messages / file activity / delivered prompts / applied permissions
  older than `retention_days` (default 7) are removed.
- **Pending prompts are never deleted**; a permission pending >15 min is marked `expired`
  and the session status recomputed.
- Every tab opens with a full `resync` (statuses + recent messages), so nothing depends on
  realtime being available - the websocket is an optimization, REST polling is the backbone.

## Development

```bash
npm install
npm run build -w plugin   # tsc → plugin/dist (worker.js, cli.js, tui.js)
npm run build -w web      # tsc -b && vite build
node test/worker-smoke.mjs  # full offline pipeline (mock OpenCode + fake Supabase)
```

Worker poll intervals are env-tunable for tests: `OPENREMOTE_TICK_MS`,
`OPENREMOTE_FILE_FLUSH_MS`, `OPENREMOTE_CLAIM_IDLE_MS`, `OPENREMOTE_CLAIM_POLL_MS`,
`OPENREMOTE_PERM_POLL_MS`, `OPENREMOTE_HEARTBEAT_MS`, `OPENREMOTE_SWEEP_MS`,
`OPENREMOTE_AUTH_REFRESH_MS`.

## Design

Digital scrapbook: warm paper grain, sticky notes, masking tape, handwritten headings (Caveat)
over monospace body (Space Mono), pastel palette, torn-note corners. Every screen, same
aesthetic.
