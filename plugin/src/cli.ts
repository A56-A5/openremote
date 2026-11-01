#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, closeSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState, StoredState, SERVE_PID_FILE, ensureConfigDir } from "./config.js";
import { isRunning, stopWorker, clearPid } from "./state.js";
import { ensureAuth } from "./supabase.js";
import { healthCheck } from "./opencode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...args] = process.argv;

function parseFlags(rest: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const k = rest[i].slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
      flags[k] = v;
    }
  }
  return flags;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// connect - start the background worker
// ---------------------------------------------------------------------------

async function connect(flags: Record<string, string>): Promise<void> {
  let state = loadState();
  let changed = false;
  if (flags.url) { state.supabaseUrl = flags.url; changed = true; }
  if (flags.key) { state.supabaseAnonKey = flags.key; changed = true; }
  if (flags.server) { state.serverUrl = flags.server; changed = true; }
  if (flags["retention-days"]) { state.retentionDays = Number(flags["retention-days"]); changed = true; }
  if (changed) saveState(state);

  if (!state.supabaseUrl || !state.supabaseAnonKey) {
    console.error(
      "openremote: Supabase not configured - pass --url/--key or set " +
        "OPENREMOTE_SUPABASE_URL / OPENREMOTE_SUPABASE_ANON_KEY."
    );
    process.exit(1);
  }

  const existing = isRunning();
  if (existing) {
    console.log(`openremote: already running (pid ${existing})`);
    return;
  }

  // owner identity (anonymous sign-in once, then refresh tokens from disk)
  await ensureAuth(state);

  const workerPath = join(__dirname, "worker.js");
  if (!existsSync(workerPath)) {
    throw new Error(`worker not built - run \`npm run build -w plugin\` in the repo root.`);
  }
  ensureConfigDir();
  const logPath = join(homedir(), ".openremote", "worker.log");
  mkdirSync(join(homedir(), ".openremote"), { recursive: true });
  let fd: number;
  try {
    fd = openSync(logPath, "a", 0o600);
  } catch {
    fd = openSync(logPath, "a");
  }
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);

  for (let i = 0; i < 12; i++) {
    await sleep(300);
    const pid = isRunning();
    if (pid) {
      console.log(`openremote: worker started (pid ${pid}) - sessions are now remotely accessible.`);
      console.log("openremote: need a pairing code for your phone? run `openremote code`.");
      return;
    }
  }
  const tail = tailLog(logPath);
  console.error(
    "openremote: worker failed to start." + (tail ? `\n${tail}` : ` (see ${logPath})`)
  );
  process.exit(1);
}

function tailLog(path: string, lines = 8): string {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stop(): Promise<void> {
  const pid = isRunning();
  if (pid) {
    stopWorker();
    for (let i = 0; i < 20; i++) {
      if (!isRunning()) break;
      await sleep(150);
    }
    if (isRunning()) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await sleep(200);
    }
    console.log("openremote: worker stopped - machine marked offline.");
  } else {
    clearPid();
    console.log("openremote: no worker running.");
  }
  // a serve we spawned dies with the worker; the TUI's own server never has a pid file
  try {
    const servePid = Number(readFileSync(SERVE_PID_FILE, "utf8").trim());
    if (Number.isFinite(servePid) && servePid > 1) {
      try { process.kill(servePid, "SIGTERM"); } catch {}
      console.log(`openremote: stopped managed opencode serve (pid ${servePid}).`);
    }
    unlinkSync(SERVE_PID_FILE);
  } catch {}
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function status(flags: Record<string, string>): Promise<void> {
  const state = loadState();
  const pid = isRunning();

  const out: Record<string, unknown> = {
    running: Boolean(pid),
    pid,
    paired: Boolean(state.ownerId),
    machineId: state.machineId ?? null,
    ownerId: state.ownerId ?? null,
    serverUrl: state.serverUrl ?? null,
    serverOk: state.serverUrl ? await healthCheck(state.serverUrl) : false,
    supabaseConfigured: Boolean(state.supabaseUrl && state.supabaseAnonKey),
    webUrl: state.webUrl,
    retentionDays: state.retentionDays,
    sessions: [] as unknown[],
    viewers: null,
    lastHeartbeat: null,
    error: null as string | null,
  };

  if (state.ownerId && state.supabaseUrl && state.supabaseAnonKey) {
    try {
      const { client } = await ensureAuth(state);
      const [sess, links, machine] = await Promise.all([
        client
          .from("sessions")
          .select("id, title, status, updated_at")
          .order("updated_at", { ascending: false })
          .limit(10),
        client.from("links").select("viewer_id").limit(100),
        state.machineId
          ? client.from("machines").select("last_heartbeat, name").eq("id", state.machineId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      out.sessions = sess.data ?? [];
      out.viewers = links.data?.length ?? 0;
      const hb = (machine as { data?: { last_heartbeat?: string } | null }).data;
      out.lastHeartbeat = hb?.last_heartbeat ?? null;
      if (sess.error) out.error = sess.error.message;
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`worker:        ${pid ? `running (pid ${pid})` : "stopped"}`);
  console.log(`machine:       ${state.machineId ?? "not registered"}${state.machineName ? ` (${state.machineName})` : ""}`);
  console.log(`owner:         ${state.ownerId ?? "no identity yet (run `openremote connect`)"}`);
  console.log(`opencode:      ${out.serverUrl ?? "auto-detect"} ${out.serverOk ? "✓" : out.serverUrl ? "✗ unreachable" : ""}`);
  console.log(`supabase:      ${state.supabaseUrl || "unset"}`);
  console.log(`viewers:       ${out.viewers ?? "?"}`);
  console.log(`retention:     ${state.retentionDays} days`);
  if (out.error) console.log(`error:         ${out.error}`);
  const sessions = out.sessions as Array<{ status: string; id: string; title?: string | null }>;
  if (sessions.length) {
    console.log("sessions:");
    for (const s of sessions) console.log(`  ${s.status.padEnd(9)} ${s.id} ${s.title ?? ""}`);
  } else if (pid) {
    console.log("sessions:      none synced yet");
  }
}

// ---------------------------------------------------------------------------
// code / unlink / config / install
// ---------------------------------------------------------------------------

async function mintCode(): Promise<void> {
  const state = loadState();
  if (!isRunning()) {
    await connect({});
  }
  const { client } = await ensureAuth(state);
  const { data, error } = await client.rpc("create_pairing", {});
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.code) throw new Error("create_pairing returned no code");
  const expires = row.expires_at ? new Date(row.expires_at).toLocaleTimeString() : "10 min";
  console.log(`\nPAIRING CODE (single use, valid until ${expires}):  ${row.code}`);
  console.log(`Open ${state.webUrl} on your phone and enter it.\n`);
}

async function unlinkCmd(rest: string[]): Promise<void> {
  const target = rest.find((a) => !a.startsWith("--"));
  const state = loadState();
  const { client } = await ensureAuth(state);

  if (target) {
    const { data, error } = await client.rpc("unlink", { p_viewer_id: target });
    if (error) throw error;
    console.log(data ? `openremote: unlinked ${target}.` : "openremote: no such viewer.");
    return;
  }

  const { data, error } = await client.from("links").select("viewer_id");
  if (error) throw error;
  const viewers = data ?? [];
  if (!viewers.length) {
    console.log("openremote: no phones linked.");
    return;
  }
  let n = 0;
  for (const v of viewers) {
    const { data: ok } = await client.rpc("unlink", { p_viewer_id: (v as { viewer_id: string }).viewer_id });
    if (ok) n++;
  }
  console.log(`openremote: unlinked ${n} phone${n === 1 ? "" : "s"}.`);
}

async function configCmd(rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const state: StoredState = loadState();
  if (flags.url) state.supabaseUrl = flags.url;
  if (flags.key) state.supabaseAnonKey = flags.key;
  if (flags.server) state.serverUrl = flags.server;
  if (flags["web-url"]) state.webUrl = flags["web-url"];
  if (flags["retention-days"]) state.retentionDays = Number(flags["retention-days"]);
  if (flags["max-sessions"]) state.maxSessions = Number(flags["max-sessions"]);
  if (flags.name) state.machineName = flags.name;
  saveState(state);
  console.log("openremote: config saved.");
}

async function install(): Promise<void> {
  const repoRoot = join(__dirname, "..", "..");
  const cliPath = join(repoRoot, "plugin", "dist", "cli.js");
  const tuiPluginSrc = join(repoRoot, "plugin", "dist", "tui.js");
  if (!existsSync(cliPath)) {
    throw new Error(`CLI not built - run \`npm install && npm run build -w plugin\` in ${repoRoot} first.`);
  }
  const binDir = join(homedir(), ".openremote", "bin");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "openremote");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${cliPath}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  console.log("openremote: CLI installed - use `openremote` in any terminal.");

  if (existsSync(tuiPluginSrc)) {
    const ocDir = join(homedir(), ".config", "opencode");
    const pluginDir = join(ocDir, "plugins");
    mkdirSync(pluginDir, { recursive: true });
    copyFileSync(tuiPluginSrc, join(pluginDir, "openremote-tui.js"));
    try { unlinkSync(join(binDir, "tui-plugin.js")); } catch {}

    // file-path plugin entries are invalid for OpenCode's loader
    const cfgPath = join(ocDir, "opencode.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      const plugins = Array.isArray(cfg.plugin) ? (cfg.plugin as unknown[]) : [];
      const cleaned = plugins.filter(
        (p) => !(typeof p === "string" && (p.includes("tui-plugin") || p.includes("openremote")))
      );
      if (cleaned.length !== plugins.length) {
        if (cleaned.length) cfg.plugin = cleaned;
        else delete cfg.plugin;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
        console.log("openremote: removed invalid file-path plugin entries from opencode.json.");
      }
    }
    console.log("openremote: native /openremote slash command installed (zero LLM). Restart OpenCode to pick it up.");
  }
}

const HELP = `openremote - remote bridge for OpenCode

Usage:
  openremote connect [--url U] [--key K] [--server U]   start the local worker
  openremote stop                                       stop worker + managed serve
  openremote status [--json]                            connection, sessions, viewers
  openremote code                                       mint a pairing code (10 min, single use)
  openremote unlink [viewer_id]                         revoke linked phone(s)
  openremote config [--url U] [--key K] [--server U]    set config
  openremote install                                    install CLI + /openremote TUI command

No passwords anywhere: the worker signs in anonymously to Supabase, the phone
pairs with a one-time code.`;

async function main(): Promise<void> {
  switch (cmd) {
    case "connect":
    case "start":
      return await connect(parseFlags(args));
    case "stop":
      return await stop();
    case "status":
      return await status(parseFlags(args));
    case "code":
      return await mintCode();
    case "unlink":
      return await unlinkCmd(args);
    case "config":
      return await configCmd(args);
    case "install":
      return await install();
    case "help":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`openremote: unknown command \`${cmd}\`\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`openremote: ${e?.message ?? e}`);
  process.exit(1);
});
