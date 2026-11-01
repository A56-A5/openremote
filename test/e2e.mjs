// E2E against REAL Supabase + a running worker + the mock OpenCode server.
// Verifies the v2 pairing/RLS/RPC surface end-to-end (the offline harness in
// worker-smoke.mjs covers the same pipeline against a fake Supabase).
//
// Prereqs (three things running):
//   1. node test/mock-opencode.mjs &
//   2. OPENCODE_SERVER_URL=http://localhost:4096 openremote connect
//   3. openremote code                      -> prints <PAIRING_CODE>
//   4. node test/e2e.mjs <PAIRING_CODE>
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const SUPA_URL = process.env.VITE_SUPABASE_URL || "https://laqoltvvcfkxaljnlfwy.supabase.co";
const KEY =
  process.env.VITE_SUPABASE_ANON_KEY ||
  readFileSync(new URL("../web/.env.local", import.meta.url), "utf8")
    .split("\n")
    .find((l) => l.startsWith("VITE_SUPABASE_ANON_KEY="))
    ?.split("=")[1];
const CODE = process.argv[2];
const MOCK = process.env.OPENREMOTE_MOCK_URL || "http://127.0.0.1:4096";
const RUN_ID = crypto.randomUUID().slice(0, 8);

if (!CODE) {
  console.error("usage: node test/e2e.mjs <PAIRING_CODE>   (see header comment for prereqs)");
  process.exit(1);
}

const sb = createClient(SUPA_URL, KEY);
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m, extra) => {
  console.error(`  ✗ ${m}`, extra ?? "");
  process.exit(1);
};

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e?.hard) fail(label, e.message);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  fail(`timeout waiting for: ${label}`);
}

console.log("[1] pair like the web app does");
const { error: authErr } = await sb.auth.signInAnonymously();
if (authErr) fail("anonymous sign-in", authErr.message);
const { data: pairData, error: pairErr } = await sb.rpc("claim_pairing", {
  p_code: CODE.trim().toUpperCase().replaceAll("-", ""),
});
if (pairErr) fail("claim_pairing rpc", pairErr.message);
const row = Array.isArray(pairData) ? pairData[0] : pairData;
if (row?.status !== "ok" || !row.owner_id) fail(`pairing status=${row?.status}`, row);
const OWNER = row.owner_id;
pass(`paired to owner ${OWNER.slice(0, 8)}…`);

console.log("[2] worker synced the owner's machine + sessions");
const machines = await waitFor(
  async () => {
    const { data, error } = await sb.from("machines").select("*").eq("owner_id", OWNER);
    if (error) throw Object.assign(new Error(error.message), { hard: true });
    return data?.length ? data : null;
  },
  8000,
  "machines visible to viewer"
);
const hb = machines[0].last_heartbeat;
if (!hb || Date.now() - Date.parse(hb) > 15 * 60_000) fail("worker heartbeat stale", hb);
pass(`machine "${machines[0].name}" online (heartbeat ${hb})`);

const sess = await waitFor(
  async () => {
    const { data, error } = await sb
      .from("sessions")
      .select("*")
      .eq("owner_id", OWNER)
      .order("updated_at", { ascending: false });
    if (error) throw Object.assign(new Error(error.message), { hard: true });
    return data?.length ? data : null;
  },
  8000,
  "sessions visible to viewer"
);
const session = sess.find((s) => s.id === "mock-session-001") ?? sess[0];
if (sess.some((s) => s.id === "mock-sub")) fail("subsession leaked into sessions");
pass(`${sess.length} session(s), primary=${session.id} status=${session.status}`);

console.log("[3] RLS: outsiders get nothing, internal tables stay shut");
const outsider = createClient(SUPA_URL, KEY);
await outsider.auth.signInAnonymously();
const { data: foreign } = await outsider.from("sessions").select("id").eq("owner_id", OWNER);
if ((foreign ?? []).length !== 0) fail("outsider can see owner sessions", foreign);
const { error: pairingsErr } = await outsider.from("pairings").select("id").limit(1);
if (!pairingsErr) fail("outsider can read pairings table");
pass("outsider sees 0 rows; pairings table inaccessible");

console.log("[4] viewer enqueues a pristine prompt (and cannot fake worker state)");
const text = `e2e ${RUN_ID}: please fix the failing test`;
const promptId = crypto.randomUUID();
const { error: insErr } = await sb.from("prompts").insert({
  id: promptId,
  session_id: session.id,
  owner_id: OWNER,
  text,
  status: "pending",
  attempts: 0,
  claimed_by: null,
  lease_until: null,
  error: null,
});
if (insErr) fail("viewer prompt insert", insErr.message);
const { data: tampered } = await sb
  .from("prompts")
  .update({ attempts: 1 })
  .eq("id", promptId)
  .select("id");
if ((tampered ?? []).length !== 0) fail("viewer could mutate attempts/claimed state");
const { data: pristine } = await sb.from("prompts").select("*").eq("id", promptId).single();
if (pristine.attempts !== 0 || pristine.status !== "pending") fail("prompt not pristine", pristine);
pass("prompt queued; claiming state untouchable by the viewer");

console.log("[5] worker delivers the prompt to OpenCode");
const received = await waitFor(
  async () => {
    const rows = await (await fetch(`${MOCK}/__received`)).json();
    return rows.find((r) => (r.parts ?? []).some((p) => p.type === "text" && p.text?.includes(text)));
  },
  45_000,
  "mock server received the prompt"
);
const { data: delivered } = await sb.from("prompts").select("status,error").eq("id", promptId).single();
if (delivered?.status !== "delivered") fail(`prompt status=${delivered?.status}`, delivered.error);
const parts = received.parts.map((p) => p.type);
if (!parts.includes("text")) fail("text part missing", parts);
pass(`delivered (parts: ${parts.join(", ")})`);

console.log("[6] permission gate: viewer decides, worker applies");
const startedAt = new Date(Date.now() - 5_000).toISOString();
const perm = await waitFor(
  async () => {
    const { data } = await sb
      .from("permissions")
      .select("*")
      .eq("session_id", session.id)
      .eq("status", "pending")
      .gte("created_at", startedAt);
    return data?.[data.length - 1] ?? null;
  },
  30_000,
  "pending permission row"
);
const { data: decide, error: dErr } = await sb.rpc("decide_permission", {
  p_id: perm.id,
  p_decision: "allowed_once",
});
if (dErr) fail("decide_permission rpc", dErr.message);
if (!(Array.isArray(decide) ? decide[0]?.session_id : decide?.session_id))
  fail("decide_permission returned nothing", decide);
pass(`decided ${perm.opencode_permission_id} → allowed_once`);

await waitFor(
  async () => {
    const { data } = await sb.from("permissions").select("applied_at").eq("id", perm.id).single();
    return data?.applied_at ? data : null;
  },
  20_000,
  "permission applied_at set by worker"
);
const replies = await (await fetch(`${MOCK}/__permissions`)).json();
const mine = replies.find((r) => r.id === perm.opencode_permission_id);
if (!mine || mine.response !== "allowed_once") fail("mock never got the reply", mine);
pass("worker replied to OpenCode");

console.log("[7] transcript + activity + status settle");
const msgs = await waitFor(
  async () => {
    const { data } = await sb
      .from("messages")
      .select("role")
      .eq("session_id", session.id)
      .order("created_at");
    const roles = (data ?? []).map((m) => m.role);
    return roles.includes("user") && roles.includes("assistant") ? roles : null;
  },
  20_000,
  "user + assistant messages in transcript"
);
pass(`messages: ${msgs.join(", ")}`);

const files = await waitFor(
  async () => {
    const { data } = await sb
      .from("file_activity")
      .select("path,edit_count,last_op")
      .eq("session_id", session.id);
    return (data ?? []).some((f) => f.edit_count >= 1) ? data : null;
  },
  20_000,
  "file_activity edit recorded"
);
pass(`file activity: ${files.map((f) => `${f.path.split("/").pop()}×${f.edit_count}`).join(", ")}`);

const settled = await waitFor(
  async () => {
    const { data } = await sb.from("sessions").select("status").eq("id", session.id).single();
    return data?.status === "done" || data?.status === "error" ? data : null;
  },
  30_000,
  "session status settles to done"
);
if (settled.status !== "done") fail("session ended in error", settled);
pass("session status=done");

console.log("[8] viewer cannot leave garbage: unlink removes access");
const { data: authSession } = await sb.auth.getSession();
const MY_ID = authSession.session?.user.id;
const { data: links } = await sb.from("links").select("viewer_id").eq("owner_id", OWNER);
const me = links.find((l) => l.viewer_id === MY_ID);
if (!me) fail("own link row not visible");
await sb.rpc("unlink", { p_viewer_id: me.viewer_id });
const { data: after } = await sb.from("sessions").select("id").eq("owner_id", OWNER);
if ((after ?? []).length !== 0) fail("unlinked viewer still sees sessions");
pass("self-unlink cut off access");

console.log("\nALL GREEN ✦");
process.exit(0);
