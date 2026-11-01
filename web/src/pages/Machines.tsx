import { useCallback, useEffect, useState } from "react";
import { isOnline, MachineRow, SessionRow, supabase } from "../lib/supabase";
import { onRow } from "../lib/bus";

const POLL_MS = 60_000; // machines are NOT in the realtime publication - REST on a slow cadence

export default function Machines({
  onOpen,
  onSettings,
}: {
  onOpen: (s: SessionRow) => void;
  onSettings: () => void;
}) {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const [m, s] = await Promise.all([
      supabase.from("machines").select("*").order("created_at", { ascending: true }),
      supabase
        .from("sessions")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(50),
    ]);
    setMachines((m.data ?? []) as MachineRow[]);
    setSessions((s.data ?? []) as SessionRow[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => setTick((x) => x + 1), POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    void load();
  }, [tick]);

  // live status/session updates without refetching everything
  useEffect(() => {
    return onRow((e) => {
      if (e.table !== "sessions") return;
      setSessions((prev) => {
        if (e.type === "DELETE") {
          const id = (e.old?.id as string) ?? (e.row.id as string);
          return prev.filter((s) => s.id !== id);
        }
        const row = e.row as unknown as SessionRow;
        const idx = prev.findIndex((s) => s.id === row.id);
        if (idx === -1) return [row, ...prev].slice(0, 50);
        const next = [...prev];
        next[idx] = { ...next[idx], ...row };
        return next;
      });
    });
  }, []);

  if (!loaded) return <div className="empty">fetching your notebook…</div>;

  if (!machines.length) {
    return (
      <div className="note white" style={{ position: "relative" }}>
        <span className="tape" />
        <h2 className="hand" style={{ fontSize: "1.8rem", margin: "0 0 6px" }}>
          no computer linked yet
        </h2>
        <p className="hint">
          Your phone is paired, but the worker on your computer hasn't checked in. On that machine
          run <code>openremote connect</code> - then come back here.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      {machines.map((m, i) => {
        const online = isOnline(m.last_heartbeat);
        const mine = sessions.filter((s) => s.machine_id === m.id);
        return (
          <div key={m.id} className={`note ${["", "blue", "pink", "green", "peach"][i % 5]}`} style={{ position: "relative" }}>
            <span className={`tape ${i % 2 ? "left" : "right"}`} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <h3 className="hand" style={{ fontSize: "1.6rem", margin: 0 }}>
                {m.name}
              </h3>
              <span className={`status-pill ${online ? "online" : "offline"}`}>
                {online ? "online" : "offline"}
              </span>
            </div>
            <div className="meta" style={{ fontSize: "0.68rem", color: "var(--ink-soft)", marginTop: 4 }}>
              {m.version ? `worker ${m.version} · ` : ""}
              {online && m.last_heartbeat
                ? `heartbeat ${new Date(m.last_heartbeat).toLocaleTimeString()}`
                : m.last_heartbeat
                  ? `last seen ${new Date(m.last_heartbeat).toLocaleString()}`
                  : "worker stopped"}
            </div>
            <hr className="divider" style={{ margin: "10px 0" }} />
            {mine.length === 0 && (
              <p className="hint" style={{ margin: 0 }}>
                no sessions yet - start (or continue) a chat in OpenCode and it appears here.
              </p>
            )}
            <div className="stack" style={{ gap: 8 }}>
              {mine.map((s) => (
                <button
                  key={s.id}
                  className="session-row"
                  onClick={() => onOpen(s)}
                  title={s.directory ?? s.id}
                >
                  <span className={`status-pill ${s.status}`}>{s.status.replace("_", " ")}</span>
                  <span className="session-row-title">{s.title || "untitled session"}</span>
                  <span className="session-row-time">{new Date(s.updated_at).toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <p className="hint" style={{ textAlign: "center" }}>
        refreshes every minute · <button className="linklike" onClick={() => void load()}>refresh now</button> ·{" "}
        <button className="linklike" onClick={onSettings}>settings</button>
      </p>
    </div>
  );
}
