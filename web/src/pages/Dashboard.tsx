import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, Session, FeedEvent } from "../lib/supabase";
import Composer from "../components/Composer";
import Doodle from "../components/Doodle";

type Tab = "feed" | "sessions" | "settings";

export default function Dashboard({ user }: { user: { id: string; email?: string } }) {
  const [tab, setTab] = useState<Tab>("feed");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };

  const loadSessions = useCallback(async () => {
    const { data } = await supabase
      .from("sessions")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(20);
    const list = (data ?? []) as Session[];
    setSessions(list);
    setActiveSession((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  const loadEvents = useCallback(async () => {
    let q = supabase.from("events").select("*").order("created_at", { ascending: true }).limit(200);
    if (activeSession) q = q.eq("session_id", activeSession);
    const { data } = await q;
    setEvents((data ?? []) as FeedEvent[]);
  }, [activeSession]);

  useEffect(() => {
    loadSessions();
    loadEvents();
    const s = supabase
      .channel("openremote-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, (payload) => {
        const e = payload.new as FeedEvent;
        if (!activeSession || e.session_id === activeSession) {
          setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e].slice(-300)));
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, () => loadSessions())
      .subscribe();
    return () => {
      supabase.removeChannel(s);
    };
  }, [activeSession, loadEvents, loadSessions]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span style={{ fontSize: "1.6rem" }}>📒</span>
          <div>
            <h1>OpenRemote</h1>
            <small>{user.email ?? "paired device"}</small>
          </div>
        </div>
        <button className="btn secondary" onClick={() => supabase.auth.signOut()}>
          unpair
        </button>
      </div>

      <div className="tabs">
        {(["feed", "sessions", "settings"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "feed" ? "✎ activity" : t === "sessions" ? "📌 sessions" : "⚙ settings"}
          </button>
        ))}
      </div>

      {tab === "feed" && (
        <>
          {sessions.length > 1 && (
            <select
              className="field"
              style={{ marginBottom: 14 }}
              value={activeSession ?? ""}
              onChange={(e) => setActiveSession(e.target.value || null)}
            >
              <option value="">all sessions</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title || s.id} — {s.status}
                </option>
              ))}
            </select>
          )}
          <div className="feed" ref={feedRef}>
            {events.length === 0 && (
              <div className="empty">
                nothing here yet… <br />
                <span style={{ fontSize: "1rem" }}>start the worker: /opencode-remote start</span>
              </div>
            )}
            {events.map((e) => (
              <article key={e.id} className={`entry ${e.kind === "user_message" ? "user" : e.kind === "assistant_message" ? "assistant" : e.kind}`}>
                {e.kind === "tool" && <div className="tool-tag">🔧 {e.tool_name ?? "tool"}</div>}
                {e.content}
                <time>{new Date(e.created_at).toLocaleString()}</time>
              </article>
            ))}
          </div>
          <div style={{ height: 22 }} />
          <Composer sessions={sessions} activeSession={activeSession} onSent={() => flash("prompt pinned to the queue ✦")} />
        </>
      )}

      {tab === "sessions" && (
        <div className="grid">
          {sessions.length === 0 && <div className="empty">no sessions registered yet</div>}
          {sessions.map((s, i) => (
            <div key={s.id} className={`note session-note ${["", "blue", "pink", "green", "peach"][i % 5]}`}>
              <span className={`tape ${i % 2 ? "left" : "right"}`} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className={`status-pill ${s.status}`}>{s.status}</span>
                <button
                  className="btn secondary"
                  style={{ fontSize: "0.9rem", padding: "1px 10px" }}
                  onClick={() => {
                    setActiveSession(s.id);
                    setTab("feed");
                  }}
                >
                  open →
                </button>
              </div>
              <h3>{s.title || "untitled session"}</h3>
              <div className="meta">{s.project_path ?? s.id}</div>
              <div className="meta" style={{ marginTop: 6 }}>
                seen {new Date(s.last_seen_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "settings" && (
        <div className="note white" style={{ maxWidth: 520, position: "relative" }}>
          <span className="tape" />
          <h2 className="hand" style={{ fontSize: "1.8rem", margin: "0 0 6px" }}>
            tidy up the desk ✂
          </h2>
          <p className="hint">
            Retention runs automatically on your computer (worker) — old activity and completed
            prompts are cleared after their window. Pending prompts are never deleted. You can also
            sweep manually here.
          </p>
          <hr className="divider" />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn danger"
              onClick={async () => {
                await supabase.rpc("cleanup_old_events", { p_session_id: activeSession, p_older_than: "0 days" });
                flash("activity cleared for this view");
                loadEvents();
              }}
            >
              clear activity
            </button>
            <button
              className="btn secondary"
              onClick={async () => {
                await supabase.rpc("cleanup_expired_prompts", { p_session_id: activeSession ?? null });
                flash("completed prompts cleared");
              }}
            >
              clear old prompts
            </button>
            <button
              className="btn secondary"
              onClick={async () => {
                if (!activeSession) return;
                if (!confirm("Wipe all activity for the selected session?")) return;
                const { data: rows } = await supabase
                  .from("prompts")
                  .select("id, attachments(storage_path)")
                  .eq("session_id", activeSession)
                  .in("status", ["done", "failed"]);
                for (const p of rows ?? []) {
                  const paths = ((p as any).attachments ?? []).map((a: any) => a.storage_path);
                  if (paths.length) await supabase.storage.from("openremote-attachments").remove(paths);
                  await supabase.from("prompts").delete().eq("id", p.id);
                }
                await supabase.from("events").delete().eq("session_id", activeSession);
                flash("session notebook wiped");
                loadEvents();
              }}
            >
              wipe session
            </button>
          </div>
          <Doodle />
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
