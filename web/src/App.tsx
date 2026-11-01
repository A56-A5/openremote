import { useCallback, useEffect, useState } from "react";
import type { Session as AuthSession } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { emitRow, RowEvent } from "./lib/bus";
import Pair from "./pages/Pair";
import Setup from "./pages/Setup";
import Machines from "./pages/Machines";
import SessionView from "./pages/SessionView";
import Settings from "./pages/Settings";
import type { SessionRow } from "./lib/supabase";

type View = { name: "machines" } | { name: "session"; session: SessionRow } | { name: "settings" };

const TABLES = ["sessions", "messages", "prompts", "permissions", "file_activity"] as const;

export default function App() {
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerReady, setOwnerReady] = useState(false);
  const [view, setView] = useState<View>({ name: "machines" });
  const [tab, setTab] = useState<"pair" | "setup">("pair");
  const [channelStatus, setChannelStatus] = useState<string>("connecting");

  // --- auth ---------------------------------------------------------------
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuth(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setAuth(s);
      if (!s) {
        setOwnerId(null);
        setOwnerReady(true);
        setView({ name: "machines" });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // --- which computer is this phone linked to? ----------------------------
  const resolveOwner = useCallback(async (session: AuthSession) => {
    const { data } = await supabase
      .from("links")
      .select("owner_id")
      .eq("viewer_id", session.user.id)
      .limit(1);
    setOwnerId((data ?? [])[0]?.owner_id ?? null);
    setOwnerReady(true);
  }, []);

  useEffect(() => {
    if (auth) void resolveOwner(auth);
    else setOwnerReady(true);
  }, [auth, resolveOwner]);

  // --- ONE realtime channel for the whole phone ---------------------------
  useEffect(() => {
    if (!ownerId || !auth) return;
    type PgPayload = {
      eventType: "INSERT" | "UPDATE" | "DELETE";
      new: Record<string, unknown>;
      old: Record<string, unknown>;
    };
    const forward =
      (table: RowEvent["table"]) =>
      (p: PgPayload): void => {
        emitRow({
          table,
          type: p.eventType,
          row: (p.eventType === "DELETE" ? p.old : p.new) as RowEvent["row"],
          old: p.old,
        });
      };
    const filter = `owner_id=eq.${ownerId}`;
    const channel = supabase
      .channel(`openremote-${ownerId.slice(0, 8)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions", filter },
        forward("sessions")
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter },
        forward("messages")
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prompts", filter },
        forward("prompts")
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "permissions", filter },
        forward("permissions")
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "file_activity", filter },
        forward("file_activity")
      )
      .subscribe((status) => setChannelStatus(status));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [ownerId, auth]);

  if (!ready) return <div className="empty">opening notebook…</div>;

  const shell = (children: React.ReactNode, subtitle: string) => (
    <div className="paper-grain">
      <div className="shell">
        <div className="topbar">
          <div className="brand">
            <span style={{ fontSize: "1.6rem" }}>📒</span>
            <div>
              <h1>OpenRemote</h1>
              <small>{subtitle}</small>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`status-pill ${channelStatus === "SUBSCRIBED" ? "online" : "offline"}`} title="realtime link">
              {channelStatus === "SUBSCRIBED" ? "live" : "polling"}
            </span>
            {ownerId && (
              <button className="btn secondary" onClick={() => setView({ name: "settings" })}>
                ⚙
              </button>
            )}
          </div>
        </div>
        {children}
      </div>
    </div>
  );

  // --- not paired: pair + setup guide --------------------------------------
  if (!auth || !ownerReady || !ownerId) {
    if (!ownerReady) return <div className="empty">checking your pairing…</div>;
    return (
      <div className="paper-grain">
        <div className="shell">
          <div className="topbar">
            <div className="brand">
              <span style={{ fontSize: "1.6rem" }}>📒</span>
              <div>
                <h1>OpenRemote</h1>
                <small>field notes for your agents</small>
              </div>
            </div>
          </div>
          <div className="tabs">
            <button className={`tab ${tab === "pair" ? "active" : ""}`} onClick={() => setTab("pair")}>
              ✉ pair
            </button>
            <button className={`tab ${tab === "setup" ? "active" : ""}`} onClick={() => setTab("setup")}>
              ✎ setup guide
            </button>
          </div>
          {tab === "pair" ? (
            <Pair
              onPaired={(owner) => {
                setOwnerId(owner);
                setView({ name: "machines" });
              }}
            />
          ) : (
            <Setup />
          )}
        </div>
      </div>
    );
  }

  // --- paired --------------------------------------------------------------
  return shell(
    view.name === "machines" ? (
      <Machines
        onOpen={(session) => setView({ name: "session", session })}
        onSettings={() => setView({ name: "settings" })}
      />
    ) : view.name === "session" ? (
      <SessionView session={view.session} onBack={() => setView({ name: "machines" })} />
    ) : (
      <Settings
        ownerId={ownerId}
        onBack={() => setView({ name: "machines" })}
        onUnpaired={() => setTab("pair")}
      />
    ),
    ownerId ? `paired · ${ownerId.slice(0, 8)}…` : "field notes for your agents"
  );
}
