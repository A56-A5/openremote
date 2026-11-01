import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { loadState, saveState, PLUGIN_VERSION, StoredState, SERVE_PID_FILE } from "./config.js";
import { ensureAuth, refreshAuth } from "./supabase.js";
import {
  connectEvents,
  promptAsync,
  replyPermission,
  resolveServerUrl,
} from "./opencode.js";
import {
  flushFileActivity,
  flushStatusTicks,
  handleEvent,
  makeContext,
  registerSessions,
  recomputeAfterPermission,
  resync,
  WorkerContext,
} from "./sync.js";
import { expireStalePermissions, sweep } from "./cleanup.js";
import { clearPid, isRunning, writePid } from "./state.js";

const numEnv = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const TICK_MS = numEnv("OPENREMOTE_TICK_MS", 1000);
const FILE_FLUSH_MS = numEnv("OPENREMOTE_FILE_FLUSH_MS", 8000);
const CLAIM_MIN_IDLE_MS = numEnv("OPENREMOTE_CLAIM_IDLE_MS", 15_000);
const CLAIM_POLL_MS = numEnv("OPENREMOTE_CLAIM_POLL_MS", 5000);
const PERM_POLL_MS = numEnv("OPENREMOTE_PERM_POLL_MS", 10_000);
const HEARTBEAT_MS = numEnv("OPENREMOTE_HEARTBEAT_MS", 60_000);
const SWEEP_MS = numEnv("OPENREMOTE_SWEEP_MS", 3_600_000);
const AUTH_REFRESH_MS = numEnv("OPENREMOTE_AUTH_REFRESH_MS", 1_800_000);

type ClaimedPrompt = { id: string; session_id: string; text: string };

async function claimAndDeliver(ctx: WorkerContext): Promise<void> {
  const { data, error } = await ctx.sb.rpc("claim_prompts", {
    p_machine_id: ctx.machineId,
    p_limit: 5,
    p_lease_seconds: 30,
  });
  if (error) {
    console.error("claim_prompts:", error.message);
    return;
  }
  for (const row of (data ?? []) as ClaimedPrompt[]) {
    try {
      await promptAsync(ctx.serverUrl, row.session_id, row.text);
      const { error: updErr } = await ctx.sb
        .from("prompts")
        .update({ status: "delivered", lease_until: null, error: null })
        .eq("id", row.id);
      if (updErr) console.error("prompt delivered write:", updErr.message);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      const { error: updErr } = await ctx.sb
        .from("prompts")
        .update({ status: "failed", error: msg, lease_until: null })
        .eq("id", row.id);
      if (updErr) console.error("prompt failed write:", updErr.message);
    }
  }
}

/** Apply viewer decisions (decided via decide_permission) to OpenCode. */
async function applyDecided(ctx: WorkerContext): Promise<void> {
  const { data, error } = await ctx.sb
    .from("permissions")
    .select("id, session_id, opencode_permission_id, status, created_at")
    .eq("owner_id", ctx.ownerId)
    .in("status", ["allowed_once", "allowed_always", "denied"])
    .is("applied_at", null);
  if (error) {
    console.error("applyDecided:", error.message);
    return;
  }
  for (const row of (data ?? []) as Array<{
    id: string;
    session_id: string;
    opencode_permission_id: string;
    status: string;
    created_at: string;
  }>) {
    const response =
      row.status === "denied" ? "reject" : row.status === "allowed_always" ? "always" : "once";
    try {
      await replyPermission(ctx.serverUrl, row.session_id, row.opencode_permission_id, response);
      const { error: updErr } = await ctx.sb
        .from("permissions")
        .update({ applied_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updErr) console.error("applied_at write:", updErr.message);
      ctx.pendingPermissions.delete(row.opencode_permission_id);
      await recomputeAfterPermission(ctx, row.session_id);
    } catch (e) {
      // session gone? give up after an hour instead of retrying forever
      if (Date.now() - Date.parse(row.created_at) > 3_600_000) {
        await ctx.sb
          .from("permissions")
          .update({ applied_at: new Date().toISOString() })
          .eq("id", row.id);
      } else {
        console.error(
          "replyPermission:",
          e instanceof Error ? e.message : e,
          `(will retry, row ${row.id})`
        );
      }
    }
  }
}

export async function runWorker(): Promise<void> {
  const existing = isRunning();
  if (existing && existing !== process.pid) {
    console.error(`openremote worker already running (pid ${existing})`);
    process.exit(1);
  }
  writePid();

  const loaded = loadState();
  const { state: authed, client } = await ensureAuth(loaded);
  const ownerId = authed.ownerId;
  if (!ownerId) throw new Error("no owner id after auth");

  // --- machine row (heartbeat holder) -------------------------------------
  let machineId = authed.machineId ?? randomUUID();
  const machineName = authed.machineName ?? hostname();
  const machineRow = () => ({
    id: machineId,
    owner_id: ownerId,
    name: machineName,
    version: PLUGIN_VERSION,
    last_heartbeat: new Date().toISOString(),
  });
  let { error: machineErr } = await client
    .from("machines")
    .upsert(machineRow(), { onConflict: "id" });
  if (machineErr) {
    // state pointed at a machine owned by a different identity - start fresh
    machineId = randomUUID();
    ({ error: machineErr } = await client.from("machines").insert(machineRow()));
  }
  if (machineErr) throw new Error(`machines: ${machineErr.message}`);

  // --- OpenCode server (env → tui handover → ports → managed serve) -------
  const resolved = await resolveServerUrl(authed.serverUrl);
  let state: StoredState = { ...authed, machineId, machineName, serverUrl: resolved.url };
  saveState(state);

  const ctx = makeContext(client, state, ownerId, machineId, resolved.url);
  try {
    const ids = await registerSessions(ctx, resolved.url);
    console.log(
      `openremote worker up → ${resolved.url}${resolved.spawned ? " (spawned serve)" : ""}` +
        ` | sessions: ${ids.length ? ids.join(", ") : "none"} | machine: ${machineId}`
    );
  } catch (e) {
    console.error("initial session sync failed (will retry on connect):", e instanceof Error ? e.message : e);
  }

  // --- lifecycle ----------------------------------------------------------
  const abort = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  let shuttingDown = false;
  let claiming = false;
  let lastClaimAt = 0;
  let spawnedChildPid: number | undefined = resolved.pid;

  const serverUrl = { current: resolved.url };
  ctx.serverUrl = serverUrl.current;

  const heartbeat = async (online = true) => {
    try {
      const { error } = await client
        .from("machines")
        .update({ last_heartbeat: online ? new Date().toISOString() : null })
        .eq("id", machineId);
      if (error) console.error("heartbeat:", error.message);
    } catch (e) {
      console.error("heartbeat:", e instanceof Error ? e.message : e);
    }
  };

  const maybeClaim = async (force = false) => {
    if (claiming) return;
    const now = Date.now();
    if (!force && ctx.working.size === 0 && now - lastClaimAt < CLAIM_MIN_IDLE_MS) return;
    claiming = true;
    lastClaimAt = now;
    try {
      await claimAndDeliver(ctx);
    } catch (e) {
      console.error("claim:", e instanceof Error ? e.message : e);
    } finally {
      claiming = false;
    }
  };

  const safe = (label: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`${label}:`, e instanceof Error ? e.message : e);
    }
  };

  // --- realtime: instant prompt delivery + permission decisions ------------
  // (REST polling below keeps working even when realtime is unreachable)
  try {
    const channel = client.channel(`openremote-worker-${machineId}`);
    channel
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "prompts", filter: `owner_id=eq.${ownerId}` },
        () => void maybeClaim(true)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "permissions", filter: `owner_id=eq.${ownerId}` },
        () => void safe("applyDecided", () => applyDecided(ctx))()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR")
          console.error("supabase realtime: channel error (falling back to polling)");
      });
  } catch (e) {
    console.error("realtime unavailable:", e instanceof Error ? e.message : e);
  }

  // --- timers -------------------------------------------------------------
  timers.push(setInterval(() => void safe("tick", () => flushStatusTicks(ctx))(), TICK_MS));
  timers.push(
    setInterval(() => void safe("fileFlush", () => flushFileActivity(ctx))(), FILE_FLUSH_MS)
  );
  timers.push(setInterval(() => void maybeClaim(), CLAIM_POLL_MS));
  timers.push(setInterval(() => void safe("applyDecided", () => applyDecided(ctx))(), PERM_POLL_MS));
  timers.push(setInterval(() => void heartbeat(), HEARTBEAT_MS));
  timers.push(
    setInterval(() => void safe("expirePerms", () => expireStalePermissions(ctx))(), 60_000)
  );
  timers.push(
    setInterval(() => void safe("sweep", () => sweep(ctx))(), SWEEP_MS)
  );
  timers.push(
    setInterval(() => {
      void (async () => {
        const next = await refreshAuth(state, client);
        if (next.ownerId && next.ownerId !== ownerId) {
          console.error(
            "auth identity changed (refresh token expired?) - rows owned by the previous " +
              "anonymous user are no longer reachable; run `openremote status`."
          );
        }
        state = { ...state, ownerId: next.ownerId ?? ownerId };
      })();
    }, AUTH_REFRESH_MS)
  );

  // --- graceful shutdown --------------------------------------------------
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abort.abort();
    for (const t of timers) clearInterval(t);
    try {
      await flushFileActivity(ctx);
      await flushStatusTicks(ctx, Date.now() + 10_000); // force deferred `done` through
    } catch {}
    await heartbeat(false); // null → offline
    try {
      await client.removeAllChannels();
    } catch {}
    if (spawnedChildPid) {
      try {
        process.kill(spawnedChildPid, "SIGTERM");
      } catch {}
      try {
        unlinkSync(SERVE_PID_FILE);
      } catch {}
    }
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // --- SSE event loop (with reconnect + re-resolve) ------------------------
  try {
    const events = connectEvents(() => serverUrl.current, {
      signal: abort.signal,
      onRetry: async (attempt) => {
        if (attempt < 2 || shuttingDown) return;
        const r = await resolveServerUrl(serverUrl.current);
        if (r.spawned) spawnedChildPid = r.pid;
        if (r.url !== serverUrl.current) {
          console.log(`opencode server changed → ${r.url}`);
          serverUrl.current = r.url;
          ctx.serverUrl = r.url;
          state = { ...state, serverUrl: r.url };
          saveState(state);
        }
      },
      onReconnect: async (attempt) => {
        console.log(`reconnected to opencode events (attempt ${attempt})`);
        await resync(ctx, serverUrl.current);
      },
    });
    for await (const ev of events) {
      if (shuttingDown) break;
      try {
        await handleEvent(ctx, ev);
      } catch (e) {
        console.error("handleEvent:", e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error("event stream:", e instanceof Error ? e.message : e);
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  runWorker().catch((e) => {
    console.error(e?.message ?? e);
    clearPid();
    process.exit(1);
  });
}
