# openremote-lite 📒

Your OpenRemote scrapbook UI, but with **no Supabase / no database / no backend you host**. The phone talks straight to `opencode serve` on your computer.

```
phone -> your hosted page (static, Vercel) -> finds your PC from the 8-char code -> tunnel -> opencode serve <- opencode attach (your terminal)
```
Both the phone and your terminal are clients of the same OpenCode server, so messages show on both and replies stream to both.

## 1. On the computer
Needs Node 18+, `opencode`, and (for use away from home) `cloudflared` (free, no account).
```bash
cd your-project
node /path/to/openremote-lite/bin/openremote.js
```
It prints a pairing code like `K7M2QX9P` (permanent until you pass `--new-code`). Type it exactly as printed, no hyphen.
In another terminal, to see the same session on the computer: `opencode attach http://127.0.0.1:4096`

### `/openremote` inside OpenCode (no LLM)

The repo ships a native TUI command, so you never type the CLI yourself:

```
/openremote      (alias /or)
```

It opens a menu (start / stop bridge, new pairing code, show code + link) in **zero LLM turns**.
Registered in `~/.config/opencode/tui.json` as `tui/openremote-tui.js`. The CLI behind it:

```bash
node bin/openremote.js start       # bridge + tunnel (default)
node bin/openremote.js code        # print the pairing code
node bin/openremote.js stop        # stop the bridge (pid in ~/.openremote-lite.pid)
node bin/openremote.js tui         # opencode attach to the same session
```

## 2. Put the page on your hosted site (one time)
The page is the single file `public/index.html`. It's static, so it deploys to the Vercel site you already have:
```bash
cd public
npx vercel link     # pick your existing "openremote" project
npx vercel --prod   # now https://openremote-link.vercel.app serves this page
```
(This replaces the old Supabase version in that project. Or drag the `public` folder onto vercel.com/new for a fresh project.)
If your site URL isn't `openremote-link.vercel.app`, run once with `--site https://your-site.vercel.app` so the terminal prints the right one.

## 3. On the phone
Open your Vercel URL, type the 8-character code once. It's remembered. No long URLs, no tokens.

How it finds your PC: when the tunnel starts, the computer posts its (random) tunnel URL to a public topic on **ntfy.sh** (free, no account) whose name is derived from your code. The page computes the same topic, reads the URL, and connects. Every API call needs your code as a password; 8 wrong tries from one IP locks it for 10 minutes.
Same Wi-Fi without a tunnel: open `http://<pc-ip>:8080` (printed in the terminal) and type the code.

## What the page does
Scrapbook design from your repo; sessions, agent chip (Build/Plan), searchable model picker, variants, slash commands (`/new /sessions /models /agents /undo /redo /compact /share /unshare /rename /fork /delete /stop /unpair` + your custom OpenCode commands), `!shell`, permission and question cards, stop button, tool calls and thinking as collapsible slips.
Not included: `@file` mentions, image attachments.

## Flags
`--dir <path>` `--port 8080` `--oc-port 4096` `--local` `--no-tunnel` `--new-code` `--site <url>`

## Security
Anyone with the code can run commands on your PC through OpenCode. Don't share it; rotate with `--new-code`; stop the tool when you're not using it. The OpenCode server only listens on 127.0.0.1.
