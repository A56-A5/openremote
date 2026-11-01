import { useState } from "react";

const INSTALL_CMD = "curl -fsSL https://raw.githubusercontent.com/A56-A5/openremote/main/install.sh | bash";

const STEPS: { title: string; note: string; cmds: string[] }[] = [
  {
    title: "1 · install the bridge",
    note: "one line. clones, builds, configures - safe to re-run anytime. (needs node ≥ 20 + git)",
    cmds: [INSTALL_CMD],
  },
  {
    title: "2 · point it at your notebook",
    note:
      "your Supabase project URL + anon key (Project settings → API). And in Supabase → " +
      "Authentication → Providers, enable Anonymous sign-ins - the computer and the phone each " +
      "sign in anonymously, so there are no passwords anywhere.",
    cmds: [
      "openremote config --url https://<project>.supabase.co --key <anon-key> --web-url https://<this-site>",
    ],
  },
  {
    title: "3 · go remote",
    note:
      "run this in your project folder (it attaches to this directory's sessions; if none is " +
      "serving, the worker starts `opencode serve` itself). Outbound-only connection - nothing " +
      "listens on your network.",
    cmds: ["openremote connect", "openremote status"],
  },
  {
    title: "4 · get a pairing code",
    note: "prints an 8-letter code, valid 10 minutes, single use. Or use /openremote inside OpenCode.",
    cmds: ["openremote code"],
  },
];

function CopyRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
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
        background: "rgba(255,255,255,0.55)",
        border: "1.5px dashed rgba(61,52,40,0.45)",
        borderRadius: "3px 8px 3px 6px",
        padding: "8px 12px",
        margin: "6px 0",
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
      {copied && <span style={{ float: "right", fontFamily: "var(--hand)", color: "#6a9a4f" }}>copied ✦</span>}
    </button>
  );
}

export default function Setup() {
  return (
    <div className="stack" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div className="note green" style={{ position: "relative" }}>
        <span className="tape" />
        <h2 className="hand" style={{ fontSize: "1.9rem", margin: "0 0 4px" }}>
          how this notebook works ✦
        </h2>
        <p className="hint" style={{ margin: 0 }}>
          A tiny worker on your computer talks to your local <code>opencode serve</code> and syncs its
          activity into this shared notebook. Your phone only needs this page. <b>Everyone pairs their own
          computer</b> - each pairing is a private account, so 3–5 friends can share this site without
          seeing each other's agents (row-level security keeps notebooks separate). Same Supabase, same
          rate limits - fine at this size.
        </p>
      </div>

      {STEPS.map((s, i) => (
        <div key={s.title} className={`note ${["white", "blue", "peach", "pink"][i % 4]}`} style={{ position: "relative" }}>
          <span className={`tape ${i % 2 ? "left" : "right"}`} />
          <h3 className="hand" style={{ fontSize: "1.45rem", margin: "0 0 2px" }}>{s.title}</h3>
          <p className="hint" style={{ margin: "0 0 6px" }}>{s.note}</p>
          {s.cmds.map((c) => (
            <CopyRow key={c} cmd={c} />
          ))}
        </div>
      ))}

      <div className="note white" style={{ position: "relative" }}>
        <span className="tape left" />
        <h3 className="hand" style={{ fontSize: "1.35rem", margin: "0 0 4px" }}>
          then, on this page ↩
        </h3>
        <p className="hint" style={{ margin: 0 }}>
          Take the code from step 4 → switch to the <b>pair</b> tab → paste it. Your sessions, notes and
          permission gates show up live. Everyday commands: <code>openremote status</code>,{" "}
          <code>openremote code</code> (fresh code), <code>openremote stop</code>,{" "}
          <code>openremote unlink</code> (revoke a phone) - or the native <code>/openremote</code> slash
          command inside OpenCode (aliases <code>/or</code>; runs locally, zero LLM turns).
        </p>
      </div>
    </div>
  );
}
