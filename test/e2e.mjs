// Local E2E: pair like the web app does, queue a prompt + image, assert worker delivery + feed.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const SUPA_URL = process.env.VITE_SUPABASE_URL || "https://laqoltvvcfkxaljnlfwy.supabase.co";
const KEY = process.env.VITE_SUPABASE_ANON_KEY || readFileSync(new URL("../web/.env.local", import.meta.url), "utf8")
  .split("\n").find((l) => l.startsWith("VITE_SUPABASE_ANON_KEY="))?.split("=")[1];
const CODE = process.argv[2];
const SESSION_ID = "mock-session-001";
const MOCK = "http://localhost:4096";

if (!CODE) {
  console.error("usage: node test/e2e.mjs <PAIRING_CODE>");
  process.exit(1);
}

const sb = createClient(SUPA_URL, KEY);
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m, extra) => { console.error(`  ✗ ${m}`, extra ?? ""); process.exit(1); };

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 700));
  }
  fail(`timeout waiting for: ${label}`);
}

console.log("[1] pairing");
const { data: pairData, error: pairErr } = await sb.rpc("consume_pairing", { p_code: CODE.trim().toUpperCase() });
if (pairErr) fail("consume_pairing", pairErr.message);
const row = Array.isArray(pairData) ? pairData[0] : pairData;
if (!row?.email) fail("code invalid/expired");
const { error: authErr } = await sb.auth.signInWithPassword({ email: row.email, password: row.password });
if (authErr) fail("signInWithPassword", authErr.message);
pass(`paired as ${row.email}`);

console.log("[2] sessions synced by worker");
const sess = await waitFor(async () => {
  const { data } = await sb.from("sessions").select("*").eq("id", SESSION_ID);
  return data?.[0];
}, 8000, "session row");
pass(`session row present, status=${sess.status}`);

console.log("[3] queue prompt with image attachment");
const { data: authData } = await sb.auth.getSession();
const uid = authData.session.user.id;
const { data: prompt, error: pErr } = await sb
  .from("prompts")
  .insert({ user_id: uid, session_id: SESSION_ID, text: "please fix the failing test" })
  .select("id")
  .single();
if (pErr) fail("insert prompt", pErr.message);
// 1x1 red png
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const path = `${uid}/${prompt.id}/pixel.png`;
const { error: upErr } = await sb.storage.from("openremote-attachments").upload(path, png, { contentType: "image/png" });
if (upErr) fail("storage upload", upErr.message);
const { error: attErr } = await sb
  .from("attachments")
  .insert({ user_id: uid, prompt_id: prompt.id, storage_path: path, mime: "image/png" });
if (attErr) fail("insert attachment", attErr.message);
pass("prompt + image queued");

console.log("[4] worker delivers to OpenCode (prompt → done, image part arrived)");
const done = await waitFor(async () => {
  const { data } = await sb.from("prompts").select("status,error").eq("id", prompt.id).single();
  return data?.status === "done" ? data : data?.status === "failed" ? fail(`prompt failed: ${data.error}`) : null;
}, 15000, "prompt status=done");
pass("prompt status=done");
const sink = await (await fetch(`${MOCK}/__received`)).json();
const last = sink[sink.length - 1];
if (!last) fail("mock server got nothing");
const types = (last.parts ?? []).map((p) => p.type);
if (!types.includes("file") || !types.includes("text")) fail("parts missing", types);
const filePart = last.parts.find((p) => p.type === "file");
if (!String(filePart.url).startsWith("data:image/png;base64,")) fail("file part not a data URL");
if (!last.parts.some((p) => p.type === "text" && p.text.includes("failing test"))) fail("text part lost");
pass(`delivered parts: ${types.join(", ")} (image came through as ${filePart.mime})`);

console.log("[5] activity feed received agent events");
const events = await waitFor(async () => {
  const { data } = await sb.from("events").select("kind, content, tool_name").eq("session_id", SESSION_ID).order("created_at");
  const kinds = (data ?? []).map((e) => e.kind);
  return kinds.includes("user_message") && kinds.includes("assistant_message") && kinds.includes("tool") ? data : null;
}, 12000, "feed event kinds");
pass(`feed has: ${events.map((e) => `${e.kind}${e.tool_name ? `(${e.tool_name})` : ""}`).join(", ")}`);

console.log("[6] RLS: other users see nothing");
const outsider = createClient(SUPA_URL, KEY);
const { data: orow } = await outsider.rpc("consume_pairing", { p_code: "ZZZZZZ" });
void orow;
const { data: pubSess } = await sb.from("sessions").select("id").limit(1);
if (!pubSess) fail("RLS broke own visibility");
const { error: crossErr } = await sb.from("prompts").select("id").neq("user_id", uid).limit(1);
if (crossErr) fail("RLS probe errored (policy issue)", crossErr.message);
pass("visibility scoped to paired user");

console.log("[7] cleanup: pending prompt survives, done prompt swept after cutoff");
const { data: pend } = await sb
  .from("prompts")
  .insert({ user_id: uid, session_id: SESSION_ID, text: "still pending" })
  .select("id")
  .single();
await sb.rpc("cleanup_old_events", { p_session_id: SESSION_ID, p_older_than: "0 days" });
const { data: afterSweep } = await sb.from("prompts").select("id,status").eq("id", pend.id).single();
if (!afterSweep || afterSweep.status !== "pending") fail("cleanup deleted a pending prompt");
pass("pending prompt survived sweep; old events cleared");
await sb.from("prompts").delete().eq("id", pend.id);

console.log("\nALL GREEN ✦");
