import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

const INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash";

const CLAIM_MSGS: Record<string, string> = {
  invalid: "That code doesn't look right - check the letters (no U, and I/L mean 1, O means 0).",
  expired: "That code expired. Run /openremote in OpenCode for a fresh one.",
  used: "That code was already used. Run /openremote in OpenCode for a fresh one.",
  throttled: "Too many tries - wait a minute and try again.",
  unauthorized: "Couldn't sign you in (anonymous sign-ins disabled?).",
};

function CopyRow({ cmd, label }: { cmd: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ margin: "6px 0" }}>
      {label && (
        <span style={{ fontSize: "0.62rem", color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 2 }}>
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(cmd).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "rgba(255,255,255,0.65)",
          border: "1.5px dashed rgba(61,52,40,0.45)",
          borderRadius: "3px 8px 3px 6px",
          padding: "8px 12px",
          cursor: "pointer",
          fontFamily: "var(--mono)",
          fontSize: "0.72rem",
          color: "var(--ink)",
          wordBreak: "break-all",
        }}
        title="click to copy"
      >
        <span style={{ color: "var(--ink-soft)" }}>$ </span>
        {cmd}
        {copied && (
          <span style={{ float: "right", fontFamily: "var(--hand)", color: "#6a9a4f", fontWeight: 600 }}>
            copied ✦
          </span>
        )}
      </button>
    </div>
  );
}

export default function Setup({
  onPaired,
  onGoToPair,
}: {
  onPaired?: (ownerId: string) => void;
  onGoToPair?: () => void;
}) {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const attempted = useRef(false);

  // Pre-fill site Supabase info for self-hosting reference
  const supaUrl =
    (import.meta as any).env?.VITE_SUPABASE_URL || "https://laqoltvvcfkxaljnlfwy.supabase.co";
  const supaKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "<anon-key>";
  const currentOrigin =
    typeof window !== "undefined" ? window.location.origin : "https://openremote-link.vercel.app";

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
        if (error) setMsg(`Sign-in note: ${error.message}`);
        else setSignedIn(true);
      })
      .catch((e) => setMsg(String(e)));
  }, []);

  async function handleClaim(e: React.FormEvent) {
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
        if (onPaired) onPaired(row.owner_id as string);
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
    <div className="stack" style={{ maxWidth: 560, margin: "0 auto" }}>
      {/* Intro Note */}
      <div className="note green" style={{ position: "relative" }}>
        <span className="tape" />
        <h2 className="hand" style={{ fontSize: "1.9rem", margin: "0 0 4px" }}>
          how this notebook works ✦
        </h2>
        <p className="hint" style={{ margin: 0 }}>
          A tiny worker on your computer talks to your local <code>opencode serve</code> and syncs its
          activity into this shared notebook. Your phone only needs this page. <b>Everyone pairs their own
          computer</b> - each pairing is a private account, so anyone can share this site without
          seeing each other's agents (row-level security keeps notebooks separate). Outbound-only
          connection, zero open ports, no passwords anywhere.
        </p>
      </div>

      {/* Step 1: Install bridge */}
      <div className="note blue" style={{ position: "relative" }}>
        <span className="tape left" />
        <h3 className="hand" style={{ fontSize: "1.5rem", margin: "0 0 2px" }}>
          1 · install the bridge
        </h3>
        <p className="hint" style={{ margin: "0 0 6px" }}>
          Run this single command in your computer's terminal. It clones, builds, configures the
          database connection, adds <code>openremote</code> to your PATH, and installs the native{" "}
          <code>/openremote</code> slash command in OpenCode. Safe to re-run anytime. (Needs Node ≥ 20 + Git)
        </p>
        <CopyRow cmd={INSTALL_CMD} />
      </div>

      {/* Step 2: Open OpenCode & run /openremote */}
      <div className="note peach" style={{ position: "relative" }}>
        <span className="tape right" />
        <h3 className="hand" style={{ fontSize: "1.5rem", margin: "0 0 2px" }}>
          2 · open OpenCode & run /openremote
        </h3>
        <p className="hint" style={{ margin: "0 0 6px" }}>
          Open your project in OpenCode and run the native command (or alias <code>/or</code>). It starts
          the bridge worker in the background and immediately shows your 8-letter pairing code!
        </p>
        <div
          style={{
            background: "rgba(255,255,255,0.7)",
            border: "1.5px solid rgba(61,52,40,0.4)",
            borderRadius: "4px 10px 4px 8px",
            padding: "10px 14px",
            margin: "6px 0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontFamily: "var(--mono)", fontSize: "0.95rem", color: "var(--ink)", fontWeight: 700 }}>
            /openremote
          </span>
          <span style={{ fontFamily: "var(--hand)", fontSize: "1.1rem", color: "var(--ink-soft)" }}>
            (or /or)
          </span>
        </div>
        <p className="hint" style={{ margin: "4px 0 0", fontSize: "0.62rem" }}>
          Prefer the terminal? Run <code>openremote code</code> to print a code from your shell anytime.
        </p>
      </div>

      {/* Step 3: Enter pairing code directly right here */}
      <div className="note white" style={{ position: "relative" }}>
        <span className="tape" />
        <h3 className="hand" style={{ fontSize: "1.55rem", margin: "0 0 4px" }}>
          3 · enter your pairing code
        </h3>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          Enter the 8-letter code shown by <code>/openremote</code> (e.g. <b>K7MX-4P2Q</b>) to pair this phone:
        </p>

        <form onSubmit={handleClaim}>
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
              fontSize: "1.2rem",
              letterSpacing: "0.3em",
              fontFamily: "var(--hand)",
              padding: "10px",
              background: "#fff",
            }}
          />

          <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
            <button className="btn" disabled={busy || code.length !== 8} type="submit">
              {busy ? "pairing…" : "pair this device →"}
            </button>
            {onGoToPair && (
              <button
                type="button"
                className="btn secondary"
                onClick={onGoToPair}
                style={{ fontSize: "1rem" }}
              >
                open pair tab
              </button>
            )}
          </div>
        </form>

        {msg && (
          <p className="hint" style={{ marginTop: 10, color: msg.includes("Paired") ? "#6a9a4f" : "var(--red)" }}>
            ✎ {msg}
          </p>
        )}
      </div>

      {/* Everyday CLI commands & self-hosting toggle */}
      <div className="note pink" style={{ position: "relative" }}>
        <span className="tape left" />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 className="hand" style={{ fontSize: "1.35rem", margin: 0 }}>
            everyday commands & self-hosting ✦
          </h3>
          <button
            type="button"
            className="linklike"
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ fontSize: "0.75rem", fontFamily: "var(--hand)" }}
          >
            {showAdvanced ? "hide ▴" : "show details ▾"}
          </button>
        </div>

        {showAdvanced && (
          <div style={{ marginTop: 10 }}>
            <p className="hint" style={{ margin: "0 0 6px" }}>
              Everyday commands you can run from anywhere in your project directory:
            </p>
            <CopyRow cmd="openremote status" label="check status, active sessions, and linked phones" />
            <CopyRow cmd="openremote code" label="mint a fresh 8-letter pairing code (10 min, single use)" />
            <CopyRow cmd="openremote stop" label="stop the background bridge worker" />
            <CopyRow cmd="openremote unlink" label="revoke access for linked phones" />

            <hr className="divider" style={{ margin: "14px 0 10px" }} />

            <h4 className="hand" style={{ fontSize: "1.2rem", margin: "0 0 4px" }}>
              self-hosting with custom supabase:
            </h4>
            <p className="hint" style={{ margin: "0 0 6px" }}>
              Point the bridge at your own Supabase project:
            </p>
            <CopyRow cmd={`openremote config --url ${supaUrl} --key ${supaKey} --web-url ${currentOrigin}`} />
          </div>
        )}
      </div>
    </div>
  );
}
