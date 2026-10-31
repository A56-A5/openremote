import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import Pair from "./pages/Pair";
import Dashboard from "./pages/Dashboard";

export default function App() {
  const [user, setUser] = useState<Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"] | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="empty">opening notebook…</div>;
  return <div className="paper-grain">{user ? <Dashboard user={user} /> : <Pair />}</div>;
}
