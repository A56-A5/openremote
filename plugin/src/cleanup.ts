import type { SupabaseClient } from "@supabase/supabase-js";
import { StoredState } from "./config.js";

export async function sweep(sb: SupabaseClient, state: StoredState, active: Set<string>) {
  const days = state.retentionDays;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  await sb.rpc("cleanup_old_events", { p_session_id: null, p_older_than: `${days} days` });

  const { data: oldPrompts } = await sb
    .from("prompts")
    .select("id, status, attachments(storage_path)")
    .in("status", ["done", "failed"])
    .lt("processed_at", cutoff);

  for (const p of oldPrompts ?? []) {
    for (const a of (p.attachments ?? []) as any[]) {
      await sb.storage.from("openremote-attachments").remove([a.storage_path]);
    }
    await sb.from("prompts").delete().eq("id", p.id);
  }

  for (const sid of active) {
    await sb.from("sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", sid);
  }
}

export async function cleanupSession(sb: SupabaseClient, sessionId: string) {
  const { data: rows } = await sb
    .from("prompts")
    .select("id, attachments(storage_path)")
    .eq("session_id", sessionId)
    .in("status", ["done", "failed"]);
  for (const p of rows ?? []) {
    for (const a of (p.attachments ?? []) as any[]) {
      await sb.storage.from("openremote-attachments").remove([a.storage_path]);
    }
    await sb.from("prompts").delete().eq("id", p.id);
  }
  await sb.from("events").delete().eq("session_id", sessionId);
}
