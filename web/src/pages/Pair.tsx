import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

const CLAIM_MSGS: Record<string, string> = {
  invalid: "That code doesn't look right - check the letters (no U, and I/L mean 1, O means 0).",
  expired: "That code expired. Run `openremote code` on your computer for a fresh one.",
  used: "That code was already used. Run `openremote code` for a new one.",
  throttled: "Too many tries - wait a minute and try again.",
  unauthorized: "Couldn't sign you in (anonymous sign-ins disabled?).",
};

export default function Pair({ onPaired }: { onPaired: (ownerId: string) => void }) {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const attempted = useRef(false);

  // anonymous sign-in happens automatically; pairing code claims on submit
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (data.session) {
          setSignedIn(true);
          return;
        }
        const { error } = await supabase.auth.signInAnonymously();
        if (error) setMsg(`Sign-in failed: ${error.message}`);
        else setSignedIn(true);
      })
      .catch((e) => setMsg(String(e)));
  }, []);

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    const norm = code.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
    if (norm.length !== 8) return;
    setBusy(true);
    setMsg(null);
    try {
      if (!signedIn) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) throw new Error(error.message);
        setSignedIn(true);
      }
      const { data, error } = await supabase.rpc("claim_pairing", { p_code: norm });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.status === "ok" && row.owner_id) {
        setMsg("Paired! Opening your notebook…");
        onPaired(row.owner_id as string);
        return;
      }
      setMsg(CLAIM_MSGS[row?.status as string] ?? "Couldn't pair - try a fresh code.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="note blue" style={{ maxWidth: 480, margin: "10px auto 0", padding: "28px 24px" }}>
      <span className="tape" />
      <h2 className="hand" style={{ margin: "0 0 4px", fontSize: "2rem" }}>
        pair your device
      </h2>
      <p className="hint">
        On your computer run <code>openremote code</code> (or the <code>/openremote</code> command
        inside OpenCode). It prints an 8-letter code like <b>K7MX-4P2Q</b> - valid 10 minutes, once.
      </p>
      <form onSubmit={claim}>
        <label className="lbl">pairing code</label>
        <input
          className="field"
          value={code}
          onChange={(e) =>
            setCode(
              e.target.value
                .toUpperCase()
                .replace(/[^0-9A-Z]/g, "")
                .slice(0, 8)
            )
          }
          placeholder="K7MX4P2Q"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={8}
          style={{
            textAlign: "center",
            fontSize: "1.1rem",
            letterSpacing: "0.3em",
            fontFamily: "var(--hand)",
          }}
        />
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="btn" disabled={busy || code.length !== 8} type="submit">
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
        First time? Run <code>curl -fsSL .../install.sh | bash</code> on your computer, then{" "}
        <code>openremote connect</code>. Full steps in the <b>setup guide</b> tab.
      </p>
    </div>
  );
}
