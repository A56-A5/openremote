---
description: Control OpenCode Remote (start/stop/status/pair/code) — $ARGUMENTS
---

Run the OpenRemote CLI via the Bash tool and report the result back verbatim (short):

`node ~/.openremote/bin/cli.js $ARGUMENTS`

If the command is `start` and it fails with "Could not find a running OpenCode server", tell the user to either run `opencode serve` in their project directory first, or pass `--server http://localhost:PORT` with the port shown by their OpenCode TUI.

If the command is `start` and it fails with a pairing/account error, tell the user to open https://openremote-link.vercel.app and follow the Setup tab.
