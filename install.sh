#!/usr/bin/env bash
# OpenRemote installer — puts the bridge + the native /openremote TUI command on your machine.
# One line:  curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash
# Overrides: OPENREMOTE_REPO, OPENREMOTE_HOME, OPENREMOTE_INSTALL_DIR
set -euo pipefail

REPO_URL="${OPENREMOTE_REPO:-https://github.com/A56-A5/openremote.git}"
HOME_DIR="${OPENREMOTE_HOME:-$HOME/.openremote}"
INSTALL_DIR="${OPENREMOTE_INSTALL_DIR:-$HOME_DIR/app}"
OC_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
TUI_FILE="$INSTALL_DIR/tui/openremote-tui.js"

say() { printf '  \033[38;5;108m➜\033[0m %s\n' "$*"; }
die() { printf '  \033[38;5;131m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "checking prerequisites"
command -v node >/dev/null 2>&1 || die "node >= 18 is required — install from https://nodejs.org"
command -v git  >/dev/null 2>&1 || die "git is required"
node -e 'process.exit(parseInt(process.version.slice(1)) >= 18 ? 0 : 1)' || die "node >= 18 is required (found $(node -v))"
if ! command -v opencode >/dev/null 2>&1; then
  say "OpenCode not found — install it first: https://opencode.ai (or follow the instructions here: https://opencode.ai/docs)"
fi

say "fetching openremote → $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  SRC="$INSTALL_DIR"
  git -C "$SRC" pull --ff-only --quiet || say "could not update existing copy (continuing)"
else
  mkdir -p "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >&2 || die "clone failed — is $REPO_URL reachable?"
  SRC="$INSTALL_DIR"
fi
[ -f "$TUI_FILE" ] || die "openremote repo is missing tui/openremote-tui.js — this does not look like openremote"

say "registering /openremote in OpenCode ($OC_CONFIG_DIR/tui.json)"
mkdir -p "$OC_CONFIG_DIR"
node - "$TUI_FILE" "$OC_CONFIG_DIR/tui.json" <<'NODE'
const fs = require('fs');
const { pathToFileURL } = require('url');
const [tuiFile, cfgPath] = process.argv.slice(2);
const entry = pathToFileURL(tuiFile).href;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
cfg['$schema'] = cfg['$schema'] || 'https://opencode.ai/tui.json';
cfg.plugin = (cfg.plugin instanceof Array ? cfg.plugin : []).filter(p => !/openremote-tui\.js$/.test(String(p)));
cfg.plugin.push(entry);
fs.mkdirSync(require('path').dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
NODE
say "registered plugin: $TUI_FILE"

if ! command -v opencode >/dev/null 2>&1; then
  printf '\n\033[38;5;180m✓ files installed\033[0m — one more step:\n'
  printf '   1. install OpenCode:  https://opencode.ai\n'
  printf '   2. cd your-project && opencode\n'
  printf '   3. type  /openremote  (alias /or) → it prints your pairing code\n'
  printf '   4. phone: https://openremote-link.vercel.app → pair tab → code\n\n'
  exit 0
fi

printf '\n\033[38;5;180m✓ ready\033[0m — next steps:\n'
printf '   1. cd your-project && opencode\n'
printf '   2. type  /openremote  (alias /or) → it prints your pairing code\n'
printf '   3. phone: https://openremote-link.vercel.app → pair tab → code\n'
printf '\n(restart opencode if /openremote does not show up right away)\n\n'