#!/usr/bin/env bash
# OpenRemote installer — puts the bridge + the native /openremote TUI command on your machine.
# One line:  curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash
# Overrides: OPENREMOTE_REPO, OPENREMOTE_HOME, OPENREMOTE_INSTALL_DIR, OPENCODE_CONFIG_DIR
# Optional deps: OPENREMOTE_SKIP_DEPS=1 (don't install cloudflared), OPENREMOTE_BIN_DIR (where to put it)
# Per-account install: everything lands in $HOME, so run this once per user. Set OPENREMOTE_ALLOW_ROOT=1 to override.
set -euo pipefail

REPO_URL="${OPENREMOTE_REPO:-https://github.com/A56-A5/openremote.git}"
HOME_DIR="${OPENREMOTE_HOME:-$HOME/.openremote}"
INSTALL_DIR="${OPENREMOTE_INSTALL_DIR:-$HOME_DIR/app}"
OC_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN_DIR="${OPENREMOTE_BIN_DIR:-$HOME/.local/bin}"
TUI_FILE="$INSTALL_DIR/tui/openremote-tui.js"

say() { printf '  \033[38;5;108m➜\033[0m %s\n' "$*"; }
warn() { printf '  \033[38;5;180m!\033[0m %s\n' "$*"; }
die() { printf '  \033[38;5;131m✗\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ] && [ -z "${OPENREMOTE_ALLOW_ROOT:-}" ]; then
  die "running as root would install into /root and register the plugin for root — rerun as your normal user (or set OPENREMOTE_ALLOW_ROOT=1 if you really mean it)"
fi

say "checking prerequisites"
command -v node >/dev/null 2>&1 || die "node >= 18 is required — install from https://nodejs.org"
command -v git  >/dev/null 2>&1 || die "git is required"
node -e 'process.exit(parseInt(process.version.slice(1)) >= 18 ? 0 : 1)' || die "node >= 18 is required (found $(node -v))"
if ! command -v opencode >/dev/null 2>&1; then
  say "OpenCode not found — install it first: https://opencode.ai (or follow the instructions here: https://opencode.ai/docs)"
fi

# cloudflared is optional at runtime (bridge falls back to same-Wi-Fi), so this
# step warns instead of failing the install.
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else return 1; fi
}

ensure_cloudflared() {
  if [ -n "${OPENREMOTE_SKIP_DEPS:-}" ]; then say "cloudflared: skipped (OPENREMOTE_SKIP_DEPS=1)"; return 0; fi
  if command -v cloudflared >/dev/null 2>&1; then say "cloudflared: found $(command -v cloudflared)"; return 0; fi
  local dest="$BIN_DIR/cloudflared" os arch url tmp ok=0
  if [ -x "$dest" ]; then say "cloudflared: already at $dest"; return 0; fi

  os="$(uname -s)"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    i386|i686) arch=386 ;;
    *) warn "cloudflared: unknown architecture — skipping (install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)"; return 0 ;;
  esac

  if [ "$os" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    say "cloudflared: installing with Homebrew"
    if brew install cloudflared >/dev/null 2>&1; then say "cloudflared: installed"; else warn "brew install failed — skipping"; fi
    return 0
  fi

  case "$os" in
    Linux)  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch" ;;
    Darwin) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$arch.tgz" ;;
    *) warn "cloudflared: unsupported OS ($os) — skipping (install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)"; return 0 ;;
  esac

  mkdir -p "$BIN_DIR"
  tmp="$(mktemp -d)"
  say "cloudflared: downloading → $dest"
  if [ "${url##*.}" = "tgz" ]; then
    if fetch "$url" "$tmp/cf.tgz" && tar -xzf "$tmp/cf.tgz" -C "$tmp" && [ -f "$tmp/cloudflared" ]; then
      cp "$tmp/cloudflared" "$dest" && chmod 0755 "$dest" && ok=1
    fi
  elif fetch "$url" "$tmp/cloudflared"; then
    cp "$tmp/cloudflared" "$dest" && chmod 0755 "$dest" && ok=1
  fi
  rm -rf "$tmp"

  if [ "$ok" -ne 1 ] || ! "$dest" --version >/dev/null 2>&1; then
    rm -f "$dest"
    warn "cloudflared: could not install — the bridge will stay same-Wi-Fi only until you install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    return 0
  fi
  say "cloudflared: installed $dest ($("$dest" --version 2>/dev/null | head -n1))"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "cloudflared: $BIN_DIR is not on PATH — add it, e.g. echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
  esac
  return 0
}

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

say "optional dependency: cloudflared (tunnel so the phone works off your Wi-Fi)"
ensure_cloudflared

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