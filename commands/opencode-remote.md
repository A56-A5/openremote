---
description: Control OpenCode Remote (start/stop/status/pair) — $ARGUMENTS
---

Run the OpenRemote CLI via the Bash tool and report the result back verbatim (short):

`npx -y @openremote/plugin $ARGUMENTS`

If the command is `start` and it fails with a pairing error, tell the user to open the OpenRemote web app, generate a pairing code, then run `/opencode-remote pair <code>`.
