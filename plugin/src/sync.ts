import type { SupabaseClient } from "@supabase/supabase-js";
import { StoredState } from "./config.js";
import { listSessions, sendMessage, eventStream, OcPart, OcEvent } from "./opencode.js";

type RegisteredSession = { id: string };

async function upsertSession(sb: SupabaseClient, state: StoredState, s: { id: string; title?: string; directory?: string }, status: string) {
  if (!state.userId) return;
  await sb.from("sessions").upsert(
    {
      id: s.id,
      user_id: state.userId,
      title: s.title ?? null,
      project_path: s.directory ?? null,
      status,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
}

async function pushEvent(
  sb: SupabaseClient,
  state: StoredState,
  e: { session_id: string; kind: string; role?: string; content?: string; tool_name?: string; meta?: unknown }
) {
  if (!state.userId) return;
  await sb.from("events").insert({ user_id: state.userId, ...e });
}

export async function registerSessions(sb: SupabaseClient, state: StoredState, serverUrl: string): Promise<RegisteredSession[]> {
  const sessions = await listSessions(serverUrl);
  const recent = sessions
    .slice()
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, 5);
  for (const s of recent) await upsertSession(sb, state, s, "online");
  return recent.map((s) => ({ id: s.id }));
}

function textOf(parts: any[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("");
}

export async function handleEvent(sb: SupabaseClient, state: StoredState, ev: OcEvent, active: Set<string>) {
  const type = ev.type ?? "";
  const props = (ev.properties ?? {}) as any;
  const sessionID = ev.sessionID ?? props.sessionID;
  if (!sessionID || !active.has(sessionID)) return;

  await sb.from("sessions").update({ last_seen_at: new Date().toISOString(), status: "online" }).eq("id", sessionID);

  if (type === "message.updated") {
    const msg = props.info;
    if (!msg) return;
    const role = msg.role;
    const text = textOf(props.parts) || msg.content || "";
    if (!text && role !== "assistant") return;
    await pushEvent(sb, state, {
      session_id: sessionID,
      kind: role === "user" ? "user_message" : "assistant_message",
      role,
      content: String(text).slice(0, 8000),
    });
    if (role === "assistant") {
      await sb.from("sessions").update({ status: "busy" }).eq("id", sessionID);
    }
    return;
  }

  if (type === "message.part.updated") {
    const part = props.part;
    if (!part) return;
    if (part.type === "tool") {
      const st = part.state ?? {};
      if (st.status === "completed" || st.status === "error") {
        await pushEvent(sb, state, {
          session_id: sessionID,
          kind: st.status === "error" ? "error" : "tool",
          tool_name: part.tool,
          content: String(st.title ?? st.output ?? "").slice(0, 4000),
          meta: { status: st.status },
        });
      }
    }
    return;
  }

  if (type === "session.updated") {
    const s = props.info;
    if (s?.id) await upsertSession(sb, state, s, "online");
    return;
  }

  if (type === "session.deleted") {
    if (sessionID) await sb.from("sessions").delete().eq("id", sessionID);
    return;
  }

  if (type === "session.error" || type === "error") {
    await pushEvent(sb, state, {
      session_id: sessionID,
      kind: "error",
      content: String(props.error?.name ?? props.name ?? "error").slice(0, 2000),
    });
  }
}

export async function deliverPrompts(sb: SupabaseClient, state: StoredState, serverUrl: string, active: Set<string>) {
  if (active.size === 0) return;
  const ids = [...active];
  const { data } = await sb
    .from("prompts")
    .select("id, session_id, text, attachments(id, storage_path, mime)")
    .eq("status", "pending")
    .in("session_id", ids)
    .lt("created_at", new Date(Date.now() - 3000).toISOString()) // grace so attachments land first
    .order("created_at", { ascending: true })
    .limit(10);
  if (!data?.length) return;

  for (const p of data) {
    await sb.from("prompts").update({ status: "processing", processing_at: new Date().toISOString() }).eq("id", p.id);
    try {
      const parts: OcPart[] = [];
      for (const a of (p.attachments ?? []) as any[]) {
        const { data: dl } = await sb.storage.from("openremote-attachments").download(a.storage_path);
        if (!dl) continue;
        const buf = await dl.arrayBuffer();
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        parts.push({
          type: "file",
          mime: a.mime ?? "image/png",
          filename: a.storage_path.split("/").pop() ?? "image.png",
          url: `data:${a.mime ?? "image/png"};base64,${btoa(bin)}`,
        });
      }
      if (p.text?.trim()) parts.push({ type: "text", text: p.text });
      await sendMessage(serverUrl, p.session_id, parts);
      await sb.from("prompts").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", p.id);
      await pushEvent(sb, state, {
        session_id: p.session_id,
        kind: "status",
        content: `Remote prompt delivered${(p.attachments ?? []).length ? ` (${p.attachments.length} image(s))` : ""}`,
      });
    } catch (err: any) {
      await sb
        .from("prompts")
        .update({ status: "failed", error: String(err?.message ?? err).slice(0, 1000), processed_at: new Date().toISOString() })
        .eq("id", p.id);
      await pushEvent(sb, state, { session_id: p.session_id, kind: "error", content: `Prompt delivery failed: ${err?.message ?? err}` });
    }
  }
}

export async function markOffline(sb: SupabaseClient, ids: string[]) {
  if (!ids.length) return;
  await sb.from("sessions").update({ status: "offline" }).in("id", ids);
}

export async function* pumpEvents(serverUrl: string) {
  yield* eventStream(serverUrl);
}
