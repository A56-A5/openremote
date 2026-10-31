import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Pair from "./pages/Pair";
import Setup from "./pages/Setup";
import Dashboard from "./pages/Dashboard";

export default function App() {
  const [user, setUser] = useState<Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"] | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"pair" | "setup">("pair");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="empty">opening notebook…</div>;
  if (user) return <div className="paper-grain"><Dashboard user={user} /></div>;

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
        {tab === "pair" ? <Pair bare /> : <Setup />}
      </div>
    </div>
  );
}
