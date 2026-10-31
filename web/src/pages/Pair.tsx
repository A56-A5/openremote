import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Pair() {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim().length < 4) return;
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc("consume_pairing", { p_code: code.trim().toUpperCase() });
    if (error) {
      setMsg(error.message);
      setBusy(false);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.email) {
      setMsg("Invalid or expired code. Generate a new one on your computer.");
      setBusy(false);
      return;
    }
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: row.email,
      password: row.password,
    });
    if (authErr) {
      setMsg(authErr.message);
      setBusy(false);
      return;
    }
    setMsg("Paired! Opening your notebook…");
  }

  return (
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

      <div style={{ position: "relative" }}>
        <div className="note blue" style={{ maxWidth: 480, margin: "30px auto 0", padding: "28px 24px" }}>
          <span className="tape" />
          <h2 className="hand" style={{ margin: "0 0 4px", fontSize: "2rem" }}>pair your device</h2>
          <p className="hint">
            On your computer, run <code>/opencode-remote start</code>. It prints a pairing code —
            scribble it in below.
          </p>
          <form onSubmit={pair}>
            <label className="lbl">pairing code</label>
            <input
              className="field"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. K7QF2M"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={8}
              style={{ textAlign: "center", fontSize: "1.1rem", letterSpacing: "0.3em", fontFamily: "var(--hand)" }}
            />
            <div className="row" style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn" disabled={busy || code.trim().length < 4} type="submit">
                {busy ? "checking…" : "pair →"}
              </button>
            </div>
          </form>
          {msg && (
            <p className="hint" style={{ marginTop: 14 }}>
              ✎ {msg}
            </p>
          )}
          <hr className="divider" />
          <p className="hint">
            First time? Run <code>openremote install</code> on your computer to add the
            <code> /opencode-remote</code> command, then configure Supabase keys with{" "}
            <code>openremote config</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
