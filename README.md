# 📒 OpenRemote

Drive your local **OpenCode** sessions from your phone browser — as a scrapbook notebook.
**No Supabase / no database / no hosted backend.** The phone talks straight to `opencode serve` on your computer.

```
phone -> your hosted page (static, Vercel) -> finds your PC from the 8-char code -> tunnel -> opencode serve <- opencode attach (your terminal)
```
Both the phone and your terminal are clients of the same OpenCode server, so messages show on both and replies stream to both.

## Install (one line)

Needs Node 18+ and `opencode`. One line, from anywhere:

```bash
curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash
```

It clones openremote into `~/.openremote/app` and registers the native `openremote` TUI plugin in `~/.config/opencode/tui.json` (creating it if needed). Restart OpenCode once.

### Dependencies

| | |
| --- | --- |
| **Node 18+**, **git** | required — the installer stops if they're missing |
| **opencode** | required at runtime; the installer warns if it can't find it |
| **cloudflared** | optional (tunnel → works off your Wi-Fi). The installer puts a static build in `~/.local/bin/cloudflared` when it's not already on your `PATH`; without it the bridge runs same-Wi-Fi only |

Skip the optional step with `OPENREMOTE_SKIP_DEPS=1`. Nothing is installed system-wide and **no sudo is needed**. Overrides: `OPENREMOTE_REPO`, `OPENREMOTE_HOME`, `OPENREMOTE_INSTALL_DIR`, `OPENCODE_CONFIG_DIR`, `OPENREMOTE_BIN_DIR`.

### Multiple users

The install is **per-account**: everything resolves from `$HOME` (app in `~/.openremote/app`, plugin in `~/.config/opencode/tui.json`, pairing code in `~/.openremote.json`, state in `~/.openremote.pid`). Each person runs the one-liner in their own account — one pairing code per user, no shared state.

The installer refuses to run as root (a `sudo curl | bash` would land in `/root` and register the plugin for root). Set `OPENREMOTE_ALLOW_ROOT=1` only if you really want that.

> Can't remember the path? The page's **setup guide** tab prints the same command.

## Getting started

```bash
# 1. install (one line)
curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash

# 2. inside OpenCode, anywhere you want remote control:
/openremote        (alias /or)
```
`/openremote` starts the bridge (proxy + tunnel), mints an 8-character pairing code (permanent until you choose a new one), and shows your status in a dialog — **zero LLM turns**.

The bridge opens in a **real terminal window** on your computer instead of hiding as a background process, so `opencode serve` and the proxy logs stay visible. Same menu → **open opencode here** attaches the live session in its own window. Set `OPENREMOTE_HEADLESS=1` if you want the old silent behaviour.

```bash
# 3. on your phone
#    https://openremote-link.vercel.app → open the code once (it's remembered)
```

### Doing it by hand (no slash command, no install)
```bash
node bin/openremote.js start                  # bridge + tunnel, prints your code
opencode attach http://127.0.0.1:4096         # same live session in another terminal
```

## What the page does
Scrapbook design from your repo; sessions, agent chip (Build/Plan), searchable model picker, variants, live context/token/cost stats sourced from OpenCode (same numbers as the OpenCode TUI), slash commands (`/new /sessions /models /agents /undo /redo /compact /share /unshare /rename /fork /delete /stop /unpair` + your custom OpenCode commands), `!shell`, permission and question cards, stop button, tool calls and thinking as collapsible slips.
Not included: `@file` mentions, image attachments.

## Notifications (phone, even when the page is closed)

Tap the 🔔 in the page once and allow notifications. The page registers a service worker, asks the
bridge for its VAPID key, and stores the browser's push subscription on your computer
(`~/.openremote-push-subs.json`). The bridge then sends a real **Web Push** (VAPID + `aes128gcm`,
RFC 8291) for every new question/permission — so your phone buzzes even with the browser closed.

- Keys are generated locally once (`~/.openremote-vapid.json`); nothing leaves your machine except
  the encrypted payload handed to your browser vendor's push service.
- While the page is open you still get an in-page toast; the OS notification is not duplicated.
- A fallback via [ntfy.sh](https://ntfy.sh) is used only if the browser refuses Web Push.
- iOS: add the page to your Home Screen first (Web Push requires an installed PWA); the included
  `manifest.webmanifest` makes it installable.
- Test it from a terminal: `curl -X POST -H 'Authorization: Bearer <code>' http://127.0.0.1:8080/api/push/test`,
  or watch the bridge log for `🔔 pushed ...`.

## Flags
`--dir <path>` `--port 8080` `--oc-port 4096` `--local` `--no-tunnel` `--new-code` `--site <url>`

## Security
Anyone with the code can run commands on your PC through OpenCode. Don't share it; rotate with `--new-code`; stop the tool when you're not using it. The OpenCode server only listens on 127.0.0.1.

## Repo map
| Path | What |
| ---- | ---- |
| `bin/openremote.js` | the bridge: reverse-proxy auth in front of `opencode serve`, ntfy rendezvous, cloudflared tunnel |
| `server.js` | zero-dependency auth + CORS proxy (used by the bridge) |
| `tui/openremote-tui.js` | native `/openremote` TUI plugin (zero LLM) |
| `public/index.html` | the phone page (pairing + scrapbook session view) — deploys to Vercel |
| `public/sw.js` | service worker: shows the Web Push notification when the page is closed |
| `public/manifest.webmanifest` | PWA manifest (installable on iOS/Android, required for iOS push) |
| `push.js` | zero-dependency Web Push: VAPID JWT, `aes128gcm` encryption, subscription store |
| `install.sh` | one-line installer that registers the TUI plugin with OpenCode |