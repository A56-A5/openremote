import type { SupabaseClient } from "@supabase/supabase-js";
import { StoredState } from "./config.js";
import { WorkerContext, recomputeAfterPermission } from "./sync.js";

/**
 * Hourly retention sweep, run as the owner (RLS scopes every delete).
 * The pending permissions stay until decided; stale ones are marked `expired`.
 */
export async function sweep(ctx: WorkerContext): Promise<void> {
  const state = ctx.state;
  const cutoff = new Date(Date.now() - state.retentionDays * 86_400_000).toISOString();

  const deletions: Array<[string, PromiseLike<{ error: { message: string } | null }>]> = [];
  deletions.push(["messages", ctx.sb.from("messages").delete().lt("created_at", cutoff)]);
  deletions.push([
    "file_activity",
    ctx.sb.from("file_activity").delete().lt("last_at", cutoff),
  ]);
  deletions.push([
    "prompts",
    ctx.sb
      .from("prompts")
      .delete()
      .in("status", ["delivered", "failed"])
      .lt("created_at", cutoff),
  ]);
  deletions.push([
    "permissions",
    ctx.sb
      .from("permissions")
      .delete()
      .neq("status", "pending")
      .lt("created_at", cutoff),
  ]);
  deletions.push(["pairing_failures", ctx.sb.rpc("cleanup_pairing_failures", {})]);

  for (const [label, req] of deletions) {
    const { error } = await req;
    if (error) console.error(`sweep ${label}:`, error.message);
  }

  await expireStalePermissions(ctx);
}

/** Pending for >15 min → expired (the asker walked away); statuses recompute. */
export async function expireStalePermissions(ctx: WorkerContext): Promise<void> {
  const stale = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data, error } = await ctx.sb
    .from("permissions")
    .update({ status: "expired", decided_at: new Date().toISOString() })
    .eq("owner_id", ctx.ownerId)
    .eq("status", "pending")
    .lt("created_at", stale)
    .select("id, session_id, opencode_permission_id");
  if (error) {
    console.error("expire permissions:", error.message);
    return;
  }
  for (const row of (data ?? []) as Array<{ session_id: string; opencode_permission_id: string }>) {
    ctx.pendingPermissions.delete(row.opencode_permission_id);
    await recomputeAfterPermission(ctx, row.session_id);
  }
}

/** Per-session cleanup used by future commands (kept exported for tests). */
export async function cleanupSession(ctx: WorkerContext, sessionId: string): Promise<void> {
  for (const [label, req] of [
    ["messages", ctx.sb.from("messages").delete().eq("session_id", sessionId)],
    ["file_activity", ctx.sb.from("file_activity").delete().eq("session_id", sessionId)],
    ["prompts", ctx.sb.from("prompts").delete().eq("session_id", sessionId)],
    ["permissions", ctx.sb.from("permissions").delete().eq("session_id", sessionId)],
  ] as Array<[string, PromiseLike<{ error: { message: string } | null }> ]>) {
    const { error } = await req;
    if (error) console.error(`cleanup ${label}:`, error.message);
  }
}

export type SweepState = Pick<StoredState, "retentionDays">;
