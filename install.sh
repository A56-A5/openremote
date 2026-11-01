#!/usr/bin/env bash
# OpenRemote installer - puts the openremote CLI on your machine, ready to pair.
# Usage:  curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash
# Overrides: OPENREMOTE_SUPABASE_URL, OPENREMOTE_SUPABASE_ANON_KEY, OPENREMOTE_WEB_URL, OPENREMOTE_REPO, OPENREMOTE_SRC, OPENREMOTE_HOME
set -euo pipefail

SUPA_URL="${OPENREMOTE_SUPABASE_URL:-https://laqoltvvcfkxaljnlfwy.supabase.co}"
SUPA_KEY="${OPENREMOTE_SUPABASE_ANON_KEY:-sb_publishable_VAJRCuUOBk4tjdspK0auJg_yZnatpL3}"
WEB_URL="${OPENREMOTE_WEB_URL:-https://openremote-link.vercel.app}"
REPO_URL="${OPENREMOTE_REPO:-https://github.com/A56-A5/openremote.git}"
HOME_DIR="${OPENREMOTE_HOME:-$HOME/.openremote}"
INSTALL_DIR="$HOME_DIR/app"

say() { printf '  \033[38;5;108m➜\033[0m %s\n' "$*"; }
die() { printf '  \033[38;5;131m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "checking prerequisites"
command -v node >/dev/null 2>&1 || die "node >= 20 is required - install from https://nodejs.org"
command -v git  >/dev/null 2>&1 || die "git is required"
node -e 'process.exit(parseInt(process.version.slice(1)) >= 20 ? 0 : 1)' || die "node >= 20 is required (found $(node -v))"

say "fetching openremote"
if [ -n "${OPENREMOTE_SRC:-}" ]; then
  SRC="$OPENREMOTE_SRC"
  [ -f "$SRC/plugin/package.json" ] || die "OPENREMOTE_SRC does not look like the repo: $SRC"
elif [ -d "$INSTALL_DIR/.git" ]; then
  SRC="$INSTALL_DIR"
  git -C "$SRC" pull --ff-only --quiet
else
  mkdir -p "$HOME_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >&2
  SRC="$INSTALL_DIR"
fi

say "installing dependencies + building bridge"
cd "$SRC"
npm install --no-audit --no-fund --loglevel=error >&2
npm run build -w plugin >&2

say "installing CLI + native /openremote command"
node "$SRC/plugin/dist/cli.js" install

say "configuring (keeps any existing pairing)"
"$HOME_DIR/bin/openremote" config --url "$SUPA_URL" --key "$SUPA_KEY" --web-url "$WEB_URL" >/dev/null

case ":$PATH:" in
  *":$HOME_DIR/bin:"*) say "PATH already includes ~/.openremote/bin" ;;
  *)
    RC=""
    [ -f "$HOME/.zshrc" ] && RC="$HOME/.zshrc"
    [ -z "$RC" ] && RC="$HOME/.bashrc"
    if ! grep -qs "\.openremote/bin" "$RC"; then
      printf '\n# openremote\nexport PATH="$HOME/.openremote/bin:$PATH"\n' >> "$RC"
      say "added ~/.openremote/bin to PATH in $RC (restart your terminal)"
    else
      say "PATH entry already present in $RC"
    fi
    ;;
esac

printf '\n\033[38;5;180m✓ ready\033[0m - next steps:\n'
printf '   1. Open OpenCode in your project\n'
printf '   2. Run /openremote (or /or) — it gives you your pairing code\n'
printf '   3. On your phone: %s → enter the code to pair!\n\n' "$WEB_URL"
printf '   (terminal alternative: run `openremote code` anytime)\n\n'
