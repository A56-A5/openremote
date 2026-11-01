import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileActivityRow,
  MessageRow,
  newId,
  PermissionRow,
  PromptRow,
  SessionRow,
  supabase,
} from "../lib/supabase";
import { onRow } from "../lib/bus";
import Composer from "../components/Composer";

const DECIDED = ["allowed_once", "allowed_always", "denied"] as const;

function statusTone(s: SessionRow["status"]): string {
  return s === "working" ? "busy" : s === "needs_you" ? "online" : s === "error" ? "error" : "offline";
}

export default function SessionView({
  session,
  onBack,
}: {
  session: SessionRow;
  onBack: () => void;
}) {
  const [cur, setCur] = useState(session);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [perms, setPerms] = useState<PermissionRow[]>([]);
  const [files, setFiles] = useState<FileActivityRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };

  const sid = cur.id;

  const load = useCallback(async () => {
    const [m, p, per, f] = await Promise.all([
      supabase.from("messages").select("*").eq("session_id", sid).order("created_at", { ascending: true }).limit(200),
      supabase.from("prompts").select("*").eq("session_id", sid).order("created_at", { ascending: false }).limit(50),
      supabase
        .from("permissions")
        .select("*")
        .eq("session_id", sid)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("file_activity")
        .select("*")
        .eq("session_id", sid)
        .order("last_at", { ascending: false })
        .limit(20),
    ]);
    setMessages((m.data ?? []) as MessageRow[]);
    setPrompts((p.data ?? []) as PromptRow[]);
    setPerms((per.data ?? []) as PermissionRow[]);
    setFiles((f.data ?? []) as FileActivityRow[]);
    setLoaded(true);
  }, [sid]);

  useEffect(() => {
    setCur(session);
    setLoaded(false);
    void load();
  }, [session, load]);

  // --- single-bus subscription --------------------------------------------
  useEffect(() => {
    return onRow((e) => {
      const rowSession = e.row.session_id as string | undefined;
      if (e.table === "sessions") {
        if (e.type === "DELETE") return;
        const row = e.row as unknown as SessionRow;
        if (row.id !== sid) return;
        setCur((prev) => ({ ...prev, ...row }));
        return;
      }
      if (rowSession !== sid) return;

      if (e.table === "messages" && e.type === "INSERT") {
        const row = e.row as unknown as MessageRow;
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      } else if (e.table === "prompts") {
        setPrompts((prev) => {
          const row = e.row as unknown as PromptRow;
          const idx = prev.findIndex((p) => p.id === row.id);
          if (e.type === "INSERT") return idx === -1 ? [row, ...prev] : prev;
          if (e.type === "DELETE") return prev.filter((p) => p.id !== row.id);
          if (idx === -1) return [row, ...prev];
          const next = [...prev];
          next[idx] = { ...next[idx], ...row };
          return next;
        });
      } else if (e.table === "permissions") {
        setPerms((prev) => {
          const row = e.row as unknown as PermissionRow;
          const idx = prev.findIndex((p) => p.id === row.id);
          if (e.type === "DELETE") return prev.filter((p) => p.id !== row.id);
          if (idx === -1) return [row, ...prev];
          const next = [...prev];
          next[idx] = { ...next[idx], ...row };
          return next;
        });
      } else if (e.table === "file_activity") {
        setFiles((prev) => {
          const row = e.row as unknown as FileActivityRow;
          const idx = prev.findIndex((f) => f.path === row.path);
          if (idx === -1) return [row, ...prev];
          const next = [...prev];
          next[idx] = { ...next[idx], ...row };
          return next.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))).slice(0, 20);
        });
      }
    });
  }, [sid]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  // --- actions --------------------------------------------------------------
  async function sendPrompt(text: string) {
    const row: PromptRow = {
      id: newId(),
      session_id: sid,
      owner_id: cur.owner_id,
      text,
      status: "pending",
      attempts: 0,
      claimed_by: null,
      lease_until: null,
      error: null,
      created_at: new Date().toISOString(),
    };
    setPrompts((prev) => [row, ...prev]);
    const { error } = await supabase.from("prompts").insert(row);
    if (error) {
      setPrompts((prev) => prev.filter((p) => p.id !== row.id));
      flash(`could not queue: ${error.message}`);
      return;
    }
    flash("pinned to the queue ✦");
  }

  async function decide(p: PermissionRow, decision: "allowed_once" | "allowed_always" | "denied") {
    setPerms((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, status: decision, decided_at: new Date().toISOString() } : x))
    );
    const { error } = await supabase.rpc("decide_permission", { p_id: p.id, p_decision: decision });
    if (error) {
      flash(`decision failed: ${error.message}`);
      void load();
      return;
    }
    flash(decision === "denied" ? "denied ✂" : "sent to your machine ✦");
  }

  async function retry(p: PromptRow) {
    const { error } = await supabase.rpc("retry_prompt", { p_id: p.id });
    if (error) flash(`retry failed: ${error.message}`);
    else flash("requeued");
  }

  // pending = not yet decided, or decided but not yet applied to OpenCode
  const actionable = perms.filter((p) => p.status === "pending");
  const inFlight = perms.filter((p) => DECIDED.includes(p.status as (typeof DECIDED)[number]) && !p.applied_at);
  const activePrompts = prompts.filter((p) => p.status === "pending" || p.status === "sending" || p.status === "failed");

  if (!loaded) return <div className="empty">opening session…</div>;

  return (
    <div className="stack">
      <div className="row-back">
        <button className="btn secondary" onClick={onBack}>
          ← machines
        </button>
        <span className={`status-pill ${statusTone(cur.status)}`}>
          {cur.status.replace("_", " ")}
        </span>
        <span className="hint" style={{ marginLeft: "auto" }}>
          {new Date(cur.status_since).toLocaleTimeString()}+
        </span>
      </div>

      <div className="note white session-head" style={{ position: "relative" }}>
        <span className="tape left" />
        <h2 className="hand" style={{ fontSize: "1.6rem", margin: "0 0 2px" }}>
          {cur.title || "untitled session"}
        </h2>
        <div className="meta" style={{ fontSize: "0.68rem", color: "var(--ink-soft)", wordBreak: "break-all" }}>
          {cur.directory ?? cur.id}
        </div>
        {files.length > 0 && (
          <div className="file-chips">
            {files.map((f) => (
              <span key={f.path} className={`file-chip ${f.last_op}`} title={f.path}>
                {f.last_op === "created" ? "＋" : f.last_op === "deleted" ? "－" : "✎"} {f.path.split("/").pop()}{" "}
                <i>×{f.edit_count}</i>
              </span>
            ))}
          </div>
        )}
      </div>

      {actionable.map((p) => (
        <div key={p.id} className="note peach perm-card" style={{ position: "relative" }}>
          <span className="tape right" />
          <div className="perm-title">🔔 {p.title ?? `${p.tool ?? "tool"} permission`}</div>
          {p.detail && Object.keys(p.detail).length > 0 && (
            <div className="perm-detail">{JSON.stringify(p.detail)}</div>
          )}
          <div className="perm-actions">
            <button className="btn" onClick={() => void decide(p, "allowed_once")}>
              allow once
            </button>
            <button className="btn secondary" onClick={() => void decide(p, "allowed_always")}>
              always
            </button>
            <button className="btn danger" onClick={() => void decide(p, "denied")}>
              deny
            </button>
          </div>
        </div>
      ))}
      {inFlight.length > 0 && (
        <div className="hint" style={{ textAlign: "center" }}>
          {inFlight.length === 1 ? "sending decision to your machine…" : `${inFlight.length} decisions sending…`}
        </div>
      )}

      <div className="feed" ref={feedRef}>
        {messages.length === 0 && (
          <div className="empty">
            notebook empty…
            <br />
            <span style={{ fontSize: "1rem" }}>leave the first note below</span>
          </div>
        )}
        {messages.map((m) => (
          <article key={m.id} className={`entry ${m.role === "user" ? "user" : "assistant"}`}>
            {m.text || (m.role === "user" ? "(note)" : "(no text)")}
            {m.truncated && <span className="hint"> …truncated</span>}
            <time>
              {m.role === "user" ? "you" : "agent"} · {new Date(m.created_at).toLocaleString()}
            </time>
          </article>
        ))}
      </div>

      {activePrompts.length > 0 && (
        <div className="queue">
          <div className="lbl" style={{ margin: "0 0 6px" }}>
            queue
          </div>
          {activePrompts.slice(0, 6).map((p) => (
            <div key={p.id} className={`queue-row ${p.status}`}>
              <span className={`status-pill ${p.status === "failed" ? "error" : p.status === "pending" ? "busy" : "online"}`}>
                {p.status}
              </span>
              <span className="queue-text">{p.text.slice(0, 80)}</span>
              {p.status === "failed" && (
                <button className="linklike" onClick={() => void retry(p)}>
                  retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <Composer onSend={sendPrompt} disabled={cur.status === "error"} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
