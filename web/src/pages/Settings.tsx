import { useState } from "react";
import { supabase } from "../lib/supabase";
import Doodle from "../components/Doodle";

export default function Settings({
  ownerId,
  onBack,
  onUnpaired,
}: {
  ownerId: string;
  onBack: () => void;
  onUnpaired: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function unpair() {
    if (!confirm("Unpair this phone from that computer? You'll need a new code.")) return;
    setBusy(true);
    const { data: auth } = await supabase.auth.getSession();
    const me = auth.session?.user.id;
    if (me) await supabase.rpc("unlink", { p_viewer_id: me });
    await supabase.auth.signOut();
    setBusy(false);
    onUnpaired();
  }

  return (
    <div className="stack" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div className="row-back">
        <button className="btn secondary" onClick={onBack}>
          ← machines
        </button>
      </div>

      <div className="note white" style={{ position: "relative" }}>
        <span className="tape" />
        <h2 className="hand" style={{ fontSize: "1.8rem", margin: "0 0 6px" }}>
          settings ⚙
        </h2>
        <p className="hint">
          This phone is linked to computer <code>{ownerId.slice(0, 8)}…</code>. Sessions, notes and
          permissions stay on that machine's side - this page only sees them while the worker is
          running. No passwords anywhere: pairing used a one-time code.
        </p>
        <hr className="divider" />
        <p className="hint">
          <b>Everyday commands</b> on your computer: <code>openremote status</code>,{" "}
          <code>openremote code</code> (fresh pairing code), <code>openremote unlink</code> (revoke a
          phone), <code>openremote stop</code>. Or the native <code>/openremote</code> slash command
          inside OpenCode - zero LLM turns.
        </p>
        <hr className="divider" />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn danger" disabled={busy} onClick={() => void unpair()}>
            {busy ? "unpairing…" : "unpair this phone"}
          </button>
        </div>
        <Doodle />
      </div>

      <div className="note blue" style={{ position: "relative" }}>
        <span className="tape right" />
        <h3 className="hand" style={{ fontSize: "1.4rem", margin: "0 0 4px" }}>
          retention
        </h3>
        <p className="hint" style={{ margin: 0 }}>
          The worker sweeps old data on your computer daily (default 7 days: messages, file
          activity, delivered prompts). Pending prompts are never deleted; a permission waiting
          longer than 15 minutes is marked expired.
        </p>
      </div>
    </div>
  );
}
