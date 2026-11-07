// OpenCode TUI plugin for openremote: native /openremote slash command.
// Zero LLM turns: it only starts/stops the bridge and shows the pairing code.
// Self-contained on purpose (node builtins only), so the file can be loaded
// straight from tui.json as file:///<repo>/tui/openremote-tui.js.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin", "openremote.js");
const CFG = join(homedir(), ".openremote.json");
const WEB_PORT = 8080;
const OC_PORT = 4096;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const FALLBACK_SITE = "https://openremote-link.vercel.app";

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
};

const topicOf = (code) =>
  "orl-" + createHash("sha256").update("orl:" + String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex").slice(0, 24);

const probe = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.status;
  } catch { return 0; }
};

// 401 without auth means our proxy answered: the bridge is up.
const isUp = async () => {
  const s = await probe(`${WEB}/api/session`);
  return s === 401 || s === 200;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodeBin = () => (process.env.OPENREMOTE_NODE || "node");

// absolute path to node from *our* PATH, so a fresh terminal window does not depend on its shell rc
const nodePath = () => {
  const env = process.env.OPENREMOTE_NODE;
  if (env) return env;
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, "node");
    try { accessSync(p, constants.X_OK); return p } catch {}
  }
  return "node";
};

const hasBin = (b) => {
  if (!b) return false;
  if (b.includes("/")) { try { accessSync(b, constants.X_OK); return true } catch { return false } }
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (!d) continue;
    try { accessSync(join(d, b), constants.X_OK); return true } catch {}
  }
  return false;
};

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Open `command` in a real terminal window so it is visible on this computer instead of
// being a headless background process. Returns true when a window was opened.
function openTerminal(title, command, dir) {
  const sh = ["sh", "-c", command];
  let candidates = [];
  if (process.platform === "darwin") {
    const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    candidates = [["osascript", ["-e", `tell application "Terminal" to do script "${q(command)}"`, "-e", `tell application "Terminal" to activate`]]];
  } else if (process.platform === "win32") {
    candidates = [["cmd", ["/c", "start", "", "cmd", "/k", command]]];
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    const t = process.env.TERMINAL;
    if (t) {
      if (/(^|\/)xdg-terminal-exec$/.test(t)) candidates.push(["xdg-terminal-exec", ["--title=" + title, "--", ...sh]]);
      else candidates.push([t, ["-e", ...sh]]);
    }
    candidates.push(
      ["x-terminal-emulator", ["-e", ...sh]],
      ["gnome-terminal", ["--title=" + title, "--", ...sh]],
      ["konsole", ["--title", title, "-e", ...sh]],
      ["kitty", ["--title", title, ...sh]],
      ["ghostty", ["-e", ...sh]],
      ["alacritty", ["-T", title, "-e", ...sh]],
      ["wezterm", ["start", "--", ...sh]],
      ["foot", ["--title", title, ...sh]],
      ["xterm", ["-T", title, "-e", ...sh]],
      ["tilix", ["-t", title, "-e", "sh -c " + shq(command)]],
      ["xfce4-terminal", ["--title=" + title, "-e", "sh -c " + shq(command)]]
    );
  }
  for (const [bin, args] of candidates) {
    if (!hasBin(bin)) continue;
    try {
      const child = spawn(bin, args, { cwd: dir || REPO, detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {}
  }
  return false;
}

// what the window runs: the bridge itself, so opencode serve + the proxy logs are all visible
const bridgeCommand = (dir, extra) =>
  ["cd", shq(REPO), "&&", shq(nodePath()), shq(BIN), "--dir", shq(dir), ...extra.map(shq)].join(" ") +
  '; ec=$?; if [ "$ec" -ne 0 ]; then echo; echo "[openremote] bridge exited with code $ec"; printf "press enter to close… "; read -r _; fi; exit "$ec"';

const cli = (args, opts = {}) =>
  new Promise((resolve) => {
    let out = "";
    const child = spawn(nodeBin(), [BIN, ...args], { cwd: REPO, ...opts });
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, out: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
  });

const startBridge = async (dir, extra = []) => {
  if (await isUp()) return true;
  let window = false;
  if (!process.env.OPENREMOTE_HEADLESS) window = openTerminal("OpenRemote", bridgeCommand(dir, extra), REPO);
  // the window may need a few seconds (or may not exist at all) — fall back to a plain
  // background launch; the pidfile in bin/openremote.js makes the loser exit instead of double-binding
  if (!window || !(await waitForUp(10))) {
    const child = spawn(nodeBin(), [BIN, "--dir", dir, ...extra], { cwd: REPO, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  return waitForUp(30);
};

const waitForUp = async (seconds) => {
  for (let i = 0; i < seconds * 2; i++) {
    if (await isUp()) return true;
    await sleep(500);
  }
  return false;
};

const tunnelUrl = async (code) => {
  try {
    const r = await fetch(`https://ntfy.sh/${topicOf(code)}/json?poll=1&since=all`, { signal: AbortSignal.timeout(2500) });
    const lines = (await r.text()).trim().split("\n").filter(Boolean);
    const msgs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && m.event === "message");
    return msgs.length ? String(msgs[msgs.length - 1].message || "").trim() : "";
  } catch { return ""; }
};

const dirOf = (api) => api?.state?.path?.directory || process.cwd();

function banner(cfg, up, tun) {
  return [
    `bridge:   ${up ? "running" : "stopped"}`,
    `code:     ${cfg?.code || "(start the bridge to mint one)"}`,
    `phone:    ${cfg?.site || FALLBACK_SITE}`,
    `same wifi: http://<this machine>:${WEB_PORT}`,
    `tunnel:   ${tun || (up ? "announcing (or cloudflared not installed)" : "off")}`,
  ].join("\n");
}

async function menu(api, dialog, note) {
  const cfg = readJson(CFG) || {};
  const up = await isUp();
  const tun = up ? await tunnelUrl(cfg.code) : "";
  if (note) api.ui.toast({ variant: "info", title: "openremote", message: note });

  dialog.replace(() =>
    api.ui.DialogSelect({
      title: `OpenRemote\n${banner(cfg, up, tun)}`,
      placeholder: "pick an action…",
      options: [
        { title: "▶  start bridge", value: "start", description: "proxy + tunnel so the phone can connect", disabled: up },
        { title: "■  stop bridge", value: "stop", description: "phone goes offline", disabled: !up },
        { title: "🖥  open opencode here", value: "attach", description: "same live session in a window on this computer", disabled: !up },
        { title: "⚿  new pairing code", value: "newcode", description: "restart with a fresh code" },
        { title: "📋  show code + link", value: "show", description: "big text to type on the phone" },
        { title: "↻  refresh", value: "refresh" },
      ],
      onSelect: (opt) => void act(api, dialog, opt.value),
    })
  );
}

async function act(api, dialog, value) {
  const dir = dirOf(api);
  if (value === "refresh") return void (await menu(api, dialog));

  if (value === "show") {
    const cfg = readJson(CFG) || {};
    const tun = await tunnelUrl(cfg.code);
    dialog.replace(() =>
      api.ui.DialogAlert({
        title: "OpenRemote · Pairing Code",
        message: `${cfg.code || "no code yet"}\n\nPhone: ${cfg.site || FALLBACK_SITE}\nSame wifi: http://<this machine>:${WEB_PORT}${tun ? "\nTunnel: " + tun : ""}\n\nType it once on the phone; it is remembered.`,
        onConfirm: () => void menu(api, dialog),
      })
    );
    return;
  }

  if (value === "attach") {
    const ok = openTerminal("opencode", `opencode attach http://127.0.0.1:${OC_PORT}`, dir);
    api.ui.toast({
      variant: ok ? "success" : "error",
      title: "openremote",
      message: ok ? "opened a window with `opencode attach`" : `no terminal found — run:  opencode attach http://127.0.0.1:${OC_PORT}`,
      duration: 6000,
    });
    return void (await menu(api, dialog));
  }

  if (value === "stop") {
    const { ok, out } = await cli(["stop"]);
    api.ui.toast({ variant: ok ? "success" : "error", title: "openremote stop", message: out.split("\n").slice(0, 3).join(" · ") || (ok ? "stopped" : "failed"), duration: 6000 });
    return void (await menu(api, dialog));
  }

  if (value === "start" || value === "newcode") {
    api.ui.toast({ variant: "info", title: "openremote", message: value === "newcode" ? "minting a new code…" : "starting bridge…" });
    if (value === "newcode" && (await isUp())) await cli(["stop"]);
    const ok = await startBridge(dir, value === "newcode" ? ["--new-code"] : []);
    if (!ok) {
      api.ui.toast({ variant: "error", title: "openremote", message: "bridge did not come up on :" + WEB_PORT + " (check your terminal for errors)", duration: 8000 });
      return void (await menu(api, dialog));
    }
    const cfg = readJson(CFG) || {};
    // the phone drives `opencode serve`, which has no UI of its own — open the same session in a
    // real window so you watch the messages live on this computer instead of a silent background
    const live = !process.env.OPENREMOTE_HEADLESS && openTerminal("OpenCode", `opencode attach http://127.0.0.1:${OC_PORT}`, dir);
    dialog.replace(() =>
      api.ui.DialogAlert({
        title: value === "newcode" ? "OpenRemote · New Code" : "OpenRemote · Running",
        message: `${cfg.code || "?"}\n\nPhone: ${cfg.site || FALLBACK_SITE}\nSame wifi: http://<this machine>:${WEB_PORT}` +
          (live ? `\n\n🖥  a live window is opening — same session the phone drives` : `\n\n🖥  watch it live: opencode attach http://127.0.0.1:${OC_PORT}`),
        onConfirm: () => void menu(api, dialog),
      })
    );
  }
}

const tui = async (api) => {
  const register = api.command?.register;
  if (!register) {
    api.ui?.toast?.({ variant: "warning", title: "openremote", message: "no api.command.register in this OpenCode build" });
    return;
  }
  const open = (dialog) => void menu(api, dialog || api.ui.dialog);
  const entries = [
    { name: "openremote", title: "OpenRemote" },
    { name: "or", title: "OpenRemote (alias /or)" },
  ].map((e) => ({
    title: e.title,
    value: "openremote-" + e.name,
    description: "pairing code + bridge control (no LLM)",
    category: "openremote",
    slash: { name: e.name, ...(e.aliases ? { aliases: e.aliases } : {}) },
    onSelect: open,
  }));
  register(() => entries);
};

export default { id: "openremote", tui };
