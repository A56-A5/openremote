import type { SupabaseClient } from "@supabase/supabase-js";
import { StoredState } from "./config.js";
import { OcEvent, OcSession, listSessions, sessionMessages, sessionStatuses } from "./opencode.js";
import {
  FileActivityBatcher,
  FileOp,
  MessageDedupe,
  SessionStatus,
  StatusDebouncer,
} from "./batcher.js";

const MESSAGE_TEXT_CAP = 8000;
const DETAIL_CAP = 1200;
const TOOLS: Record<string, FileOp> = {
  write: "created",
  edit: "edited",
  patch: "edited",
  apply_patch: "edited",
};

export type MsgBuf = {
  sessionId: string;
  role: "user" | "assistant";
  texts: string[];
  completedAt?: number;
  wroteEmpty?: boolean;
};

function joinTexts(buf: MsgBuf): string {
  return buf.texts.join("").trim();
}

export type WorkerContext = {
  sb: SupabaseClient;
  state: StoredState;
  ownerId: string;
  machineId: string;
  serverUrl: string;
  batcher: FileActivityBatcher;
  status: StatusDebouncer;
  dedupe: MessageDedupe;
  /** message id → buffered parts (only completed messages are ever written) */
  messages: Map<string, MsgBuf>;
  /** opencode permission id → session id for rows we inserted */
  pendingPermissions: Map<string, string>;
  /** sessions with an in-flight turn (drives poll cadence + status) */
  working: Set<string>;
  /** `${sessionId}\0${path}` → seen (classifies write as created vs edited) */
  knownPaths: Set<string>;
  activeSessionId?: string;
  touch(sessionId: string): void;
};

export function makeContext(
  sb: SupabaseClient,
  state: StoredState,
  ownerId: string,
  machineId: string,
  serverUrl: string
): WorkerContext {
  const ctx: WorkerContext = {
    sb,
    state,
    ownerId,
    machineId,
    serverUrl,
    batcher: new FileActivityBatcher(),
    status: new StatusDebouncer(),
    dedupe: new MessageDedupe(),
    messages: new Map(),
    pendingPermissions: new Map(),
    working: new Set(),
    knownPaths: new Set(),
    touch(sessionId: string) {
      if (sessionId) this.activeSessionId = sessionId;
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// status / row writers
// ---------------------------------------------------------------------------

async function writeStatus(
  ctx: WorkerContext,
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  const { error } = await ctx.sb
    .from("sessions")
    .update({
      status,
      status_since: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .neq("status", status);
  if (error) console.error("writeStatus:", error.message);
}

/** The one place that decides status transitions and performs the DB write. */
export async function setStatus(
  ctx: WorkerContext,
  sessionId: string,
  status: SessionStatus,
  opts: { immediate?: boolean } = {}
): Promise<void> {
  if (status === "working") ctx.working.add(sessionId);
  else if (status === "done") ctx.working.delete(sessionId);

  const changed = opts.immediate
    ? ctx.status.flushNow(sessionId, status)
    : ctx.status.setDesired(sessionId, status);
  if (changed) await writeStatus(ctx, sessionId, status);
}

export async function flushStatusTicks(ctx: WorkerContext, at = Date.now()): Promise<void> {
  for (const { sessionId, status } of ctx.status.tick(at)) {
    await writeStatus(ctx, sessionId, status);
  }
}

async function upsertSessionRow(
  ctx: WorkerContext,
  s: { id: string; title?: string; directory?: string }
): Promise<void> {
  const { error } = await ctx.sb.from("sessions").upsert(
    {
      id: s.id,
      machine_id: ctx.machineId,
      owner_id: ctx.ownerId,
      title: s.title ?? null,
      directory: s.directory ?? null,
      status: "done",
      status_since: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
  if (error) console.error("upsertSession:", error.message);
  ctx.status.seed(s.id, "done");
  ctx.touch(s.id);
}

async function writeMessage(
  ctx: WorkerContext,
  info: { id: string; sessionId: string; role: "user" | "assistant"; completedAt: number },
  text: string
): Promise<void> {
  const capped = text.length > MESSAGE_TEXT_CAP;
  const { error } = await ctx.sb.from("messages").upsert(
    {
      id: info.id,
      session_id: info.sessionId,
      owner_id: ctx.ownerId,
      role: info.role,
      text: capped ? text.slice(0, MESSAGE_TEXT_CAP) : text,
      truncated: capped,
      created_at: new Date(info.completedAt).toISOString(),
    },
    { onConflict: "id" }
  );
  if (error) console.error("writeMessage:", error.message);
}

/**
 * PostgREST upsert replaces `edit_count`, so the current value must be read
 * back and incremented (returns delta for brand-new rows).
 */
export async function flushFileActivity(ctx: WorkerContext): Promise<void> {
  if (!ctx.batcher.dirty) return;
  const rows = ctx.batcher.flush();
  for (const row of rows) {
    const { data } = await ctx.sb
      .from("file_activity")
      .select("edit_count")
      .eq("session_id", row.sessionId)
      .eq("path", row.path)
      .maybeSingle();
    const editCount = ((data as { edit_count?: number } | null)?.edit_count ?? 0) + row.editCount;
    const { error } = await ctx.sb.from("file_activity").upsert(
      {
        session_id: row.sessionId,
        owner_id: ctx.ownerId,
        path: row.path,
        edit_count: editCount,
        last_op: row.lastOp,
        first_at: new Date(row.firstAt).toISOString(),
        last_at: new Date(row.lastAt).toISOString(),
      },
      { onConflict: "session_id,path" }
    );
    if (error) console.error("file_activity:", error.message);
    ctx.knownPaths.add(`${row.sessionId}\u0000${row.path}`);
  }
}

// ---------------------------------------------------------------------------
// registration / resync
// ---------------------------------------------------------------------------

/** Single latest session only - fixates OpenRemote to 1 session. */
export async function registerSessions(ctx: WorkerContext, serverUrl: string): Promise<string[]> {
  const sessions = await listSessions(serverUrl);
  const recent = sessions
    .filter((s) => !s.parentID)
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, 1);

  for (const s of recent) await upsertSessionRow(ctx, s);

  // Keep only this 1 single active session in DB
  if (recent[0]) {
    await ctx.sb.from("sessions").delete().eq("owner_id", ctx.ownerId).neq("id", recent[0].id);
  }

  const ids = recent.map((s) => s.id);
  if (ids.length) {
    const { data } = await ctx.sb
      .from("file_activity")
      .select("session_id, path")
      .in("session_id", ids);
    for (const row of (data ?? []) as Array<{ session_id: string; path: string }>) {
      ctx.knownPaths.add(`${row.session_id}\u0000${row.path}`);
    }

    // recover needs_you after a restart: pending permission rows still count
    const { data: perms } = await ctx.sb
      .from("permissions")
      .select("session_id, opencode_permission_id")
      .eq("status", "pending")
      .in("session_id", ids);
    for (const p of (perms ?? []) as Array<{ session_id: string; opencode_permission_id: string }>) {
      ctx.pendingPermissions.set(p.opencode_permission_id, p.session_id);
      await setStatus(ctx, p.session_id, "needs_you", { immediate: true });
    }
  }
  return ids;
}

/** After a reconnect: refresh session rows, statuses and pending permissions. */
export async function resync(ctx: WorkerContext, serverUrl: string): Promise<void> {
  const ids = await registerSessions(ctx, serverUrl);

  try {
    const statuses = await sessionStatuses(serverUrl);
    for (const [sessionId, st] of Object.entries(statuses)) {
      if (!ids.includes(sessionId)) continue;
      if (st.type === "busy") await setStatus(ctx, sessionId, "working");
      else if (st.type === "idle") await setStatus(ctx, sessionId, "done");
    }
  } catch (e) {
    console.error("resync statuses:", e instanceof Error ? e.message : e);
  }

  // backfill messages we may have missed while offline
  for (const sessionId of ids.slice(0, 10)) {
    try {
      const msgs = await sessionMessages(serverUrl, sessionId, 10);
      for (const m of msgs) {
        const completedAt = m.info.time?.completed ?? m.info.time?.created;
        if (m.info.role === "assistant" && !m.info.time?.completed) continue;
        if (
          !ctx.dedupe.consider({
            id: m.info.id,
            role: m.info.role,
            completedAt: completedAt ?? Date.now(),
          })
        )
          continue;
        const text = (m.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        await writeMessage(
          ctx,
          {
            id: m.info.id,
            sessionId,
            role: m.info.role,
            completedAt: completedAt ?? Date.now(),
          },
          text
        );
      }
    } catch {
      // session may be gone; ignore
    }
  }
}

// ---------------------------------------------------------------------------
// event handling
// ---------------------------------------------------------------------------

function propSessionId(ev: OcEvent): string | undefined {
  const p = (ev.properties ?? {}) as Record<string, unknown>;
  const nested = p.part as { sessionID?: string } | undefined;
  const info = p.info as { sessionID?: string } | undefined;
  const perm = p.permission as { sessionID?: string } | undefined;
  return (
    (p.sessionID as string | undefined) ??
    nested?.sessionID ??
    info?.sessionID ??
    perm?.sessionID ??
    ev.sessionID
  );
}

function capDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object") return {};
  try {
    return JSON.stringify(detail).length <= DETAIL_CAP
      ? (detail as Record<string, unknown>)
      : { truncated: true };
  } catch {
    return {};
  }
}

function pathsFromPatch(patchText: string): Array<{ path: string; op: FileOp }> {
  const out: Array<{ path: string; op: FileOp }> = [];
  const re = /^\*\*\*\s*(Add|Update|Delete) File:\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patchText))) {
    const op: FileOp = m[1] === "Add" ? "created" : m[1] === "Delete" ? "deleted" : "edited";
    out.push({ path: m[2].trim(), op });
  }
  return out;
}

function hasPendingPermission(ctx: WorkerContext, sessionId: string): boolean {
  for (const sid of ctx.pendingPermissions.values()) if (sid === sessionId) return true;
  return false;
}

async function handlePermissionAsked(
  ctx: WorkerContext,
  p: Record<string, unknown>
): Promise<void> {
  const sessionID = propSessionId({
    type: "permission.asked",
    properties: p,
  });
  const id = (p.id ?? p.permissionID ?? p.requestID) as string | undefined;
  if (!sessionID || !id) return;

  const tool =
    (p.type as string | undefined) ??
    (p.permission as string | undefined) ??
    ((p.tool as { name?: string } | undefined)?.name as string | undefined) ??
    null;
  const title =
    (p.title as string | undefined) ?? (tool ? `${tool} permission` : "permission needed");
  const pattern = p.pattern ?? p.patterns ?? undefined;
  const metadata = capDetail(p.metadata ?? (typeof p.tool === "object" ? p.tool : undefined));

  const { error } = await ctx.sb.from("permissions").upsert(
    {
      session_id: sessionID,
      owner_id: ctx.ownerId,
      opencode_permission_id: id,
      tool,
      title: String(title).slice(0, 300),
      detail: { ...(pattern ? { pattern } : {}), ...metadata },
      status: "pending",
    },
    { onConflict: "opencode_permission_id", ignoreDuplicates: true }
  );
  if (error) {
    console.error("permission insert:", error.message);
    return;
  }
  ctx.pendingPermissions.set(id, sessionID);
  ctx.touch(sessionID);
  await setStatus(ctx, sessionID, "needs_you", { immediate: true });
}

async function handlePermissionReplied(
  ctx: WorkerContext,
  p: Record<string, unknown>
): Promise<void> {
  const id = (p.permissionID ?? p.requestID ?? p.id) as string | undefined;
  if (!id) return;
  const sessionID = ctx.pendingPermissions.get(id) ?? (p.sessionID as string | undefined);
  if (!sessionID) return;

  const { error } = await ctx.sb
    .from("permissions")
    .update({
      status: "resolved_locally",
      decided_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    })
    .eq("opencode_permission_id", id)
    .eq("status", "pending");
  if (error) console.error("permission replied:", error.message);

  ctx.pendingPermissions.delete(id);
  await recomputeAfterPermission(ctx, sessionID);
}

/** After the last pending permission for a session is gone, go back to working/done. */
export async function recomputeAfterPermission(ctx: WorkerContext, sessionId: string): Promise<void> {
  const { data } = await ctx.sb
    .from("permissions")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .limit(1);
  if ((data ?? []).length) return;
  await setStatus(ctx, sessionId, ctx.working.has(sessionId) ? "working" : "done");
}

async function handleMessageUpdated(
  ctx: WorkerContext,
  info: Record<string, unknown>
): Promise<void> {
  const id = info.id as string | undefined;
  const sessionId = info.sessionID as string | undefined;
  const role = info.role as "user" | "assistant" | undefined;
  if (!id || !sessionId || (role !== "user" && role !== "assistant")) return;

  const time = (info.time ?? {}) as { created?: number; completed?: number };
  const completedAt = role === "user" ? time.created ?? Date.now() : time.completed;
  if (!completedAt) return; // assistant not finished - never write mid-turn

  const buf = ctx.messages.get(id) ?? { sessionId, role, texts: [] };
  buf.sessionId = sessionId;
  buf.role = role;
  buf.completedAt = completedAt;

  let text = joinTexts(buf);

  // If text is still empty, query OpenCode REST API for the message parts
  if (!text) {
    try {
      const msgs = await sessionMessages(ctx.serverUrl, sessionId, 10);
      const found = msgs.find((m) => m.info.id === id);
      if (found) {
        const partsText = (found.parts ?? [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("");
        if (partsText) {
          buf.texts = [partsText];
          text = partsText;
        }
      }
    } catch {}
  }

  if (!ctx.dedupe.consider({ id, role, completedAt })) {
    // already written; patch it if we stored it empty and text arrived later
    if (buf.wroteEmpty && text) {
      await writeMessage(ctx, { id, sessionId, role, completedAt }, text);
      buf.wroteEmpty = false;
    }
    return;
  }

  await writeMessage(ctx, { id, sessionId, role, completedAt }, text);
  buf.wroteEmpty = text.length === 0;
  ctx.messages.set(id, buf);
}

function handlePartUpdated(ctx: WorkerContext, part: Record<string, unknown>): void {
  const type = part.type as string | undefined;
  const sessionId = part.sessionID as string | undefined;
  const messageId = part.messageID as string | undefined;
  if (!sessionId) return;
  ctx.touch(sessionId);

  if (type === "text" && messageId) {
    const text = (part.text ?? part.delta) as string | undefined;
    if (!text) return;
    const buf =
      ctx.messages.get(messageId) ?? ({ sessionId, role: "assistant", texts: [] } as MsgBuf);
    buf.texts.push(text);
    ctx.messages.set(messageId, buf);
    if (buf.completedAt && buf.wroteEmpty) {
      const info = { id: messageId, sessionId: buf.sessionId, role: buf.role, completedAt: buf.completedAt };
      void writeMessage(ctx, info, joinTexts(buf)).then(() => {
        buf.wroteEmpty = false;
      });
    }
    return;
  }

  if (type === "tool") {
    const state = part.state as
      | { status?: string; input?: Record<string, unknown> }
      | undefined;
    if (!state || (state.status !== "completed" && state.status !== "error")) return;
    const tool = part.tool as string | undefined;
    if (!tool) return;

    if (tool === "apply_patch") {
      const patchText = String(state.input?.patchText ?? state.input?.patch ?? "");
      for (const { path, op } of pathsFromPatch(patchText)) {
        ctx.batcher.record(sessionId, path, op);
        ctx.knownPaths.add(`${sessionId}\u0000${path}`);
      }
      return;
    }

    const op = TOOLS[tool];
    if (!op) return;
    const input = state.input ?? {};
    const path = (input.path ?? input.filePath ?? input.file) as string | undefined;
    if (!path) return;
    const key = `${sessionId}\u0000${path}`;
    const effective: FileOp = op === "created" && ctx.knownPaths.has(key) ? "edited" : op;
    ctx.batcher.record(sessionId, path, effective);
    ctx.knownPaths.add(key);
  }
}

export async function handleEvent(ctx: WorkerContext, ev: OcEvent): Promise<void> {
  const type = ev.type ?? "";
  const props = (ev.properties ?? {}) as Record<string, unknown>;

  switch (type) {
    case "session.created":
    case "session.updated": {
      const info = props.info as OcSession | undefined;
      if (!info?.id || info.parentID) return;
      await upsertSessionRow(ctx, info);
      return;
    }
    case "session.deleted": {
      const info = props.info as { id?: string } | undefined;
      const sessionId = info?.id ?? propSessionId(ev);
      if (!sessionId) return;
      const { error } = await ctx.sb.from("sessions").delete().eq("id", sessionId);
      if (error) console.error("session delete:", error.message);
      return;
    }
    case "session.status": {
      const sessionId = (props.sessionID as string | undefined) ?? propSessionId(ev);
      const st = props.status as { type?: string } | undefined;
      if (!sessionId || !st?.type) return;
      if (hasPendingPermission(ctx, sessionId)) {
        if (st.type === "busy") ctx.working.add(sessionId);
        else ctx.working.delete(sessionId);
      } else if (st.type === "busy") {
        await setStatus(ctx, sessionId, "working");
      } else if (st.type === "idle") {
        await setStatus(ctx, sessionId, "done");
      }
      return;
    }
    case "session.idle": {
      const sessionId = (props.sessionID as string | undefined) ?? propSessionId(ev);
      if (!sessionId) return;
      await flushFileActivity(ctx);
      // Flush latest messages from OpenCode to make sure assistant answers and user prompts are fully synced
      try {
        const msgs = await sessionMessages(ctx.serverUrl, sessionId, 5);
        for (const m of msgs) {
          const mText = (m.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text as string)
            .join("");
          if (mText) {
            const completedAt =
              m.info.role === "user" ? m.info.time?.created ?? Date.now() : m.info.time?.completed ?? Date.now();
            await writeMessage(ctx, { id: m.info.id, sessionId, role: m.info.role, completedAt }, mText);
          }
        }
      } catch {}
      if (!hasPendingPermission(ctx, sessionId)) await setStatus(ctx, sessionId, "done");
      else ctx.working.delete(sessionId);
      return;
    }
    case "session.error": {
      const sessionId = (props.sessionID as string | undefined) ?? propSessionId(ev);
      if (!sessionId) return;
      await setStatus(ctx, sessionId, "error", { immediate: true });
      return;
    }
    case "message.updated": {
      const info = props.info as Record<string, unknown> | undefined;
      if (!info) return;
      const sessionId = info.sessionID as string | undefined;
      if (!sessionId) return;
      ctx.touch(sessionId);
      await handleMessageUpdated(ctx, info);
      return;
    }
    case "message.part.updated": {
      const part = props.part as Record<string, unknown> | undefined;
      if (part) handlePartUpdated(ctx, part);
      return;
    }
    case "message.part.delta": {
      const part = (props.part ?? props) as Record<string, unknown> | undefined;
      if (part) handlePartUpdated(ctx, part);
      return;
    }
    case "session.next.text.delta": {
      const p = props as { assistantMessageID?: string; sessionID?: string; delta?: string };
      if (p.assistantMessageID && p.delta) {
        handlePartUpdated(ctx, {
          type: "text",
          sessionID: p.sessionID,
          messageID: p.assistantMessageID,
          text: p.delta,
        });
      }
      return;
    }
    case "session.next.text.ended": {
      const p = props as { assistantMessageID?: string; sessionID?: string; text?: string };
      if (p.assistantMessageID && p.text) {
        const buf = ctx.messages.get(p.assistantMessageID) ?? {
          sessionId: p.sessionID ?? "",
          role: "assistant",
          texts: [],
        };
        buf.texts = [p.text];
        ctx.messages.set(p.assistantMessageID, buf);
        if (buf.completedAt) {
          await writeMessage(
            ctx,
            { id: p.assistantMessageID, sessionId: buf.sessionId, role: buf.role, completedAt: buf.completedAt },
            p.text
          );
        }
      }
      return;
    }
    case "permission.updated":
    case "permission.asked":
    case "permission.v2.asked": {
      const merged = props.permission
        ? { ...(props.permission as Record<string, unknown>), ...props }
        : props;
      await handlePermissionAsked(ctx, merged);
      return;
    }
    case "permission.replied":
    case "permission.v2.replied": {
      await handlePermissionReplied(ctx, props);
      return;
    }
    case "file.edited": {
      const file = props.file as string | undefined;
      const sessionId =
        (props.sessionID as string | undefined) ?? ev.sessionID ?? ctx.activeSessionId;
      if (!file || !sessionId) return;
      const key = `${sessionId}\u0000${file}`;
      ctx.batcher.record(sessionId, file, ctx.knownPaths.has(key) ? "edited" : "created");
      ctx.knownPaths.add(key);
      return;
    }
    default:
      return;
  }
}
