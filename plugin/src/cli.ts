#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadState, saveState, StoredState } from "./config.js";
import { isRunning, stopWorker, clearPid } from "./state.js";
import { clientForState, ensureAuth, saveAuth } from "./supabase.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [, , cmd, ...args] = process.argv;

function parseFlags(rest: string[]) {
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

async function mintCode(state: StoredState, client: SupabaseClient): Promise<string> {
  if (!state.userId || !state.email || !state.accountPassword) {
    throw new Error("No local account yet — run `openremote start` first.");
  }
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 6 }, () => alphabet[randomBytes(1)[0] % alphabet.length]).join("");
    const { error } = await client.from("pairing_codes").insert({
      code,
      user_id: state.userId,
      email: state.email,
      password: state.accountPassword,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    if (!error) return code;
    if (!String(error.message).includes("duplicate")) throw error;
  }
  throw new Error("Could not mint a pairing code.");
}

async function ensureAccount(state: StoredState): Promise<{ state: StoredState; client: SupabaseClient; code?: string }> {
  const client = await clientForState(state);
  const { data: cur } = await client.auth.getSession();
  if (cur.session && state.userId) {
    return { state, client };
  }
  if (state.email && state.accountPassword) {
    const { error } = await client.auth.signInWithPassword({ email: state.email, password: state.accountPassword });
    if (!error) {
      const { data } = await client.auth.getSession();
      const s = data.session;
      if (s) {
        const next = { ...state, accessToken: s.access_token, refreshToken: s.refresh_token, userId: s.user.id };
        saveState(next);
        return { state: next, client };
      }
    }
  }
  const email = `dev-${randomBytes(5).toString("hex")}@openremote.local`;
  const password = randomBytes(18).toString("base64url");
  let userId: string | undefined;
  if (state.supabaseSecretKey) {
    const res = await fetch(`${state.supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: state.supabaseSecretKey,
        Authorization: `Bearer ${state.supabaseSecretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (res.ok) {
      userId = ((await res.json()) as any).id;
    }
  }
  if (!userId) {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error || !data.session) {
      throw new Error(
        `Could not create local account: ${error?.message ?? "no session returned"}. ` +
          `If the project requires email confirmation, set a secret key: openremote config --secret <sb_secret_...>`
      );
    }
    userId = data.session.user.id;
  }
  const { data: signIn, error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr || !signIn.session) {
    throw new Error(`Account created but sign-in failed: ${signInErr?.message ?? "no session"}`);
  }
  const next: StoredState = {
    ...state,
    email,
    accountPassword: password,
    accessToken: signIn.session.access_token,
    refreshToken: signIn.session.refresh_token,
    userId: signIn.session.user.id,
  };
  saveState(next);
  const code = await mintCode(next, client);
  return { state: next, client, code };
}

async function start(flags: Record<string, string>) {
  let state = loadState();
  if (flags.url) state.supabaseUrl = flags.url;
  if (flags.key) state.supabaseAnonKey = flags.key;
  if (flags.secret) state.supabaseSecretKey = flags.secret;
  if (flags.server) state.serverUrl = flags.server;
  if (flags["retention-days"]) state.retentionDays = Number(flags["retention-days"]);
  if (flags.url || flags.key || flags.secret || flags["retention-days"]) saveState(state);

  const existing = isRunning();
  if (existing) {
    console.log(`openremote: already running (pid ${existing})`);
    return;
  }

  const { state: authed, code } = await ensureAccount(state);
  saveState(authed);

  const child = spawn(process.execPath, [join(__dirname, "worker.js")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await new Promise((r) => setTimeout(r, 700));
  const pid = isRunning();
  if (!pid) {
    console.error("openremote: worker failed to start — check config and pairing (`openremote status`).");
    process.exit(1);
  }
  console.log(`openremote: worker started (pid ${pid}) — sessions are now remotely accessible.`);
  if (code) {
    console.log(`\nPAIRING CODE (valid 15 min, shown once):  ${code}\nOpen your web app and enter it to link this notebook.\n`);
  } else {
    console.log("openremote: need a fresh pairing code? run `openremote code`.");
  }
}

function stop() {
  if (stopWorker()) console.log("openremote: worker stopped — sessions marked offline.");
  else {
    clearPid();
    console.log("openremote: no worker running.");
  }
}

async function status() {
  const state = loadState();
  const pid = isRunning();
  console.log(`worker: ${pid ? `running (pid ${pid})` : "stopped"}`);
  console.log(`account: ${state.email ?? "not paired"}`);
  console.log(`supabase: ${state.supabaseUrl || "unset"}`);
  console.log(`opencode server: ${state.serverUrl ?? "auto-detect"}`);
  console.log(`retention: ${state.retentionDays} days`);
  if (pid && state.supabaseUrl && state.accessToken) {
    try {
      const sb = await ensureAuth(state);
      const { data } = await sb.client.from("sessions").select("id, title, status").order("last_seen_at", { ascending: false }).limit(10);
      console.log("sessions:");
      for (const s of data ?? []) console.log(`  - ${s.status.padEnd(7)} ${s.id} ${s.title ?? ""}`);
    } catch (e: any) {
      console.log(`sessions: error — ${e?.message ?? e}`);
    }
  }
}

async function pair(rest: string[]) {
  const code = rest.find((a) => !a.startsWith("--"));
  if (!code) {
    console.error("usage: openremote pair <code>");
    process.exit(1);
  }
  let state = loadState();
  const client = await clientForState(state);
  const { data, error } = await client.rpc("consume_pairing", { p_code: code.trim().toUpperCase() });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.email) {
    console.error("openremote: invalid or expired pairing code.");
    process.exit(1);
  }
  const { error: authErr } = await client.auth.signInWithPassword({ email: row.email, password: row.password });
  if (authErr) throw authErr;
  await saveAuth(state, client);
  console.log(`openremote: paired as ${row.email}. Run \`openremote start\`.`);
}

async function configCmd(rest: string[]) {
  const flags = parseFlags(rest);
  const state = loadState();
  if (flags.url) state.supabaseUrl = flags.url;
  if (flags.key) state.supabaseAnonKey = flags.key;
  if (flags.secret) state.supabaseSecretKey = flags.secret;
  if (flags.server) state.serverUrl = flags.server;
  if (flags["retention-days"]) state.retentionDays = Number(flags["retention-days"]);
  saveState(state);
  console.log("openremote: config saved.");
}

async function install() {
  const { mkdirSync, cpSync, writeFileSync, chmodSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join: j } = await import("node:path");
  const binDir = j(homedir(), ".openremote", "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(join(__dirname), binDir, { recursive: true });
  const wrapper = j(binDir, "openremote");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node "${j(binDir, "cli.js")}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const destDir = j(homedir(), ".config", "opencode", "commands");
  mkdirSync(destDir, { recursive: true });
  const mdSrc = join(__dirname, "..", "..", "commands", "opencode-remote.md");
  const { copyFileSync, existsSync } = await import("node:fs");
  if (existsSync(mdSrc)) {
    copyFileSync(mdSrc, j(destDir, "opencode-remote.md"));
    console.log("openremote: /opencode-remote command installed. Restart OpenCode to pick it up.");
  } else {
    console.log(`openremote: binary installed to ${binDir}. Command md not found at ${mdSrc} — copy commands/opencode-remote.md into ~/.config/opencode/commands/ manually.`);
  }
}

async function main() {
  switch (cmd) {
    case "start": return start(parseFlags(args));
    case "stop": return stop();
    case "status": return status();
    case "pair": return pair(args);
    case "code": {
      const state = loadState();
      const client = await clientForState(state);
      const { data } = await client.auth.getSession();
      if (data.session) await client.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
      const code = await mintCode(state, client);
      console.log(`PAIRING CODE (valid 15 min):  ${code}`);
      return;
    }
    case "config": return configCmd(args);
    case "install": return install();
    default:
      console.log(`openremote — remote bridge for OpenCode

Usage:
  openremote start [--server URL] [--retention-days N]   start the local worker (creates account + pairing code)
  openremote stop                                        stop the worker
  openremote status                                      connection + sessions
  openremote code                                        mint a fresh pairing code for the web app
  openremote pair <code>                                 pair with a code minted elsewhere
  openremote config [--url U] [--key K] [--server U]     set config
  openremote install                                     install /opencode-remote command`);
  }
}

main().catch((e) => {
  console.error(`openremote: ${e?.message ?? e}`);
  process.exit(1);
});
