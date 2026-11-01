#!/usr/bin/env node
// Offline integration smoke for the v2 worker:
//   CLI connect → worker → fake Supabase (real supabase-js over HTTP) → mock OpenCode (SSE)
// Covers: session sync, prompt claim/delivery, message writes, permission
// decide→apply round trip, file activity, status transitions, stop/offline.
// Run: node test/worker-smoke.mjs   (no network, no credentials)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FAKE = `http://127.0.0.1:${process.env.FAKE_SUPABASE_PORT || 54321}`;
const MOCK = `http://127.0.0.1:${process.env.MOCK_OC_PORT || 4096}`;
const SESSION_ID = "mock-session-001";

const children = [];
const testHome = mkdtempSync(join(tmpdir(), "openremote-smoke-"));

const ENV = {
  ...process.env,
  HOME: testHome,
  OPENREMOTE_SUPABASE_URL: FAKE,
  OPENREMOTE_SUPABASE_ANON_KEY: "fake-anon-key",
  OPENCODE_SERVER_URL: MOCK,
  OPENREMOTE_TICK_MS: "300",
  OPENREMOTE_FILE_FLUSH_MS: "800",
  OPENREMOTE_CLAIM_IDLE_MS: "800",
  OPENREMOTE_CLAIM_POLL_MS: "700",
  OPENREMOTE_PERM_POLL_MS: "700",
  OPENREMOTE_HEARTBEAT_MS: "3000",
};

let step = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
function fail(m, extra) {
  console.error(`  ✗ ${m}`, extra ?? "");
  dumpLog();
  shutdown(1);
}
function check(cond, m, extra) {
  if (!cond) fail(m, extra);
  pass(m);
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  fail(`timeout waiting for: ${label}`, last instanceof Error ? last.message : last);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProc(file, args = [], name = file) {
  const child = spawn(process.execPath, [file, ...args], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  child.out = "";
  child.stdout.on("data", (d) => (child.out += d));
  child.stderr.on("data", (d) => (child.out += d));
  child.tag = name;
  children.push(child);
  return child;
}

async function waitLine(child, re, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(child.out)) return true;
    await sleep(150);
  }
  fail(`timeout waiting for line ${re} (${label})`, child.out.slice(-600));
}

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "plugin", "dist", "cli.js"), ...args], {
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function rest(path, opts = {}) {
  const res = await fetch(`${FAKE}${path}`, {
    headers: { apikey: "fake-anon-key", "content-type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function signup() {
  const { status, data } = await rest("/auth/v1/signup", { method: "POST", body: {} });
  if (status !== 200) fail("auth signup", JSON.stringify(data));
  return data;
}

const rows = async (table) => (await rest(`/__rows?table=${table}`)).data ?? [];

function dumpLog() {
  const log = join(testHome, ".openremote", "worker.log");
  if (existsSync(log)) {
    console.error("\n--- worker.log (tail) ---");
    console.error(readFileSync(log, "utf8").split("\n").slice(-30).join("\n"));
  }
}

function shutdown(code) {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));

// ---------------------------------------------------------------------------

async function main() {
  console.log("[setup] fake supabase + mock opencode");
  const fake = spawnProc(join(ROOT, "test", "fake-supabase.mjs"), [], "fake");
  const mock = spawnProc(join(ROOT, "test", "mock-opencode.mjs"), [], "mock");
  await waitLine(fake, /\[fake\] supabase stand-in/, 5000, "fake up");
  await waitLine(mock, /\[mock\] opencode mock listening/, 5000, "mock up");

  console.log(`[1] cli status (fresh HOME: ${testHome})`);
  let r = await cli(["status", "--json"]);
  check(r.code === 0, "status exits 0");
  let st = JSON.parse(r.out.slice(r.out.indexOf("{")));
  check(st.running === false, "not running yet");
  check(st.supabaseConfigured === true, "supabase config from env");

  console.log("[2] connect starts the worker");
  r = await cli(["connect"]);
  check(r.code === 0, "connect exits 0", r.out);
  check(/worker started \(pid \d+\)/.test(r.out), "worker pid reported", r.out);

  console.log("[3] worker registers machine + syncs sessions");
  const machine = await waitFor(async () => (await rows("machines"))[0], 8000, "machines row");
  check(Boolean(machine.last_heartbeat), "heartbeat set");
  const sessions = await waitFor(async () => {
    const s = await rows("sessions");
    return s.find((x) => x.id === SESSION_ID) ? s : null;
  }, 8000, "session row");
  const session = sessions.find((x) => x.id === SESSION_ID);
  check(!sessions.some((x) => x.parentID), "subsessions excluded");
  check(session.status === "done", "initial status done", session.status);

  console.log("[4] viewer pairs (link) + enqueues a prompt");
  const viewer = await signup();
  const owner = machine.owner_id;
  const linkRes = await rest("/rest/v1/links", {
    method: "POST",
    body: { owner_id: owner, viewer_id: viewer.user.id, created_at: new Date().toISOString() },
    headers: {
      authorization: `Bearer ${viewer.access_token}`,
      prefer: "return=representation",
    },
  });
  check(linkRes.status === 201, "link row inserted", linkRes.status);
  const promptId = randomUUID();
  const promptRes = await rest("/rest/v1/prompts", {
    method: "POST",
    body: {
      id: promptId,
      session_id: SESSION_ID,
      owner_id: owner,
      text: "please fix the failing test",
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
    },
    headers: {
      authorization: `Bearer ${viewer.access_token}`,
      prefer: "return=representation",
    },
  });
  check(promptRes.status === 201, "prompt queued by viewer");

  console.log("[5] worker claims + delivers to OpenCode");
  const prompted = await waitFor(async () => {
    const p = (await rows("prompts")).find((x) => x.id === promptId);
    if (p?.status === "failed") fail(`prompt failed: ${p.error}`);
    return p?.status === "delivered" ? p : null;
  }, 20000, "prompt delivered");
  check(prompted.attempts === 1, "attempts=1");
  const sink = await (await fetch(`${MOCK}/__received`)).json();
  check(
    sink.some((s) => s.text.includes("failing test")),
    "mock received prompt text"
  );

  console.log("[6] permission ask → viewer decides → worker applies");
  const perm = await waitFor(async () => (await rows("permissions"))[0], 10000, "permission row");
  check(perm.status === "pending", "permission pending");
  check(String(perm.title ?? "").includes("Bash"), "permission title", perm.title);
  const decide = await rest("/rest/v1/rpc/decide_permission", {
    method: "POST",
    body: { p_id: perm.id, p_decision: "allowed_once" },
    headers: { authorization: `Bearer ${viewer.access_token}` },
  });
  check(decide.status === 200 && decide.data?.[0]?.status !== "unauthorized", "viewer decided", JSON.stringify(decide.data));
  const applied = await waitFor(async () => {
    const p = (await rows("permissions")).find((x) => x.id === perm.id);
    return p?.applied_at ? p : null;
  }, 15000, "decision applied to opencode");
  check(applied.status === "allowed_once", "status allowed_once");
  const permSink = await (await fetch(`${MOCK}/__permissions`)).json();
  check(permSink.some((p) => p.response === "once"), "mock got permission reply", JSON.stringify(permSink));

  console.log("[7] transcript + file activity + status settle");
  const msgs = await waitFor(async () => {
    const m = await rows("messages");
    return m.length >= 2 ? m : null;
  }, 15000, "messages written");
  check(
    msgs.some((m) => m.role === "user" && m.text.includes("failing test")),
    "user message persisted"
  );
  check(
    msgs.some((m) => m.role === "assistant" && m.text.includes("handled remotely")),
    "assistant message persisted (completed only)"
  );
  const fa = await waitFor(async () => {
    const f = await rows("file_activity");
    return f.find((x) => x.path === "src/app.ts") ?? null;
  }, 10000, "file activity");
  check(fa.edit_count >= 1 && fa.last_op === "edited", "file_activity counted", JSON.stringify(fa));
  const settled = await waitFor(async () => {
    const s = (await rows("sessions")).find((x) => x.id === SESSION_ID);
    return s?.status === "done" ? s : null;
  }, 15000, "status settles to done (debounced)");
  check(Boolean(settled.status_since), "status_since set");

  console.log("[8] status --json + pairing code");
  r = await cli(["status", "--json"]);
  st = JSON.parse(r.out.slice(r.out.indexOf("{")));
  check(st.running === true, "status reports running");
  check(st.serverOk === true, "server health ok");
  check(st.viewers === 1, "viewer visible");
  check(
    (st.sessions ?? []).some((s) => s.id === SESSION_ID),
    "session listed in status"
  );
  r = await cli(["code"]);
  check(r.code === 0, "code exits 0", r.out);
  check(
    /PAIRING CODE[\s\S]*[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.test(r.out),
    "pairing code format XXXX-XXXX",
    r.out
  );
  const pairRows = await rows("pairings");
  check(
    pairRows.length === 1 && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(pairRows[0].code_hash ?? ""),
    "pairing row stored as 8-char code hash",
    JSON.stringify(pairRows[0])
  );

  console.log("[9] stop marks machine offline");
  r = await cli(["stop"]);
  check(r.code === 0, "stop exits 0", r.out);
  const off = await waitFor(async () => {
    const m = (await rows("machines"))[0];
    return m && m.last_heartbeat === null ? m : null;
  }, 8000, "heartbeat nulled");
  r = await cli(["status", "--json"]);
  st = JSON.parse(r.out.slice(r.out.indexOf("{")));
  check(st.running === false, "status reports stopped");
  void off;

  console.log("\nALL GREEN ✦");
  shutdown(0);
}

main().catch((e) => fail("unhandled", e?.stack ?? e));
