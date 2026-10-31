import { useState } from "react";

const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || "https://YOUR_PROJECT.supabase.co";
const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || "YOUR_PUBLISHABLE_KEY";

const STEPS: { title: string; note: string; cmds: string[] }[] = [
  {
    title: "1 · grab the bridge",
    note: "runs on your computer, next to OpenCode. one-time setup (~2 min).",
    cmds: [
      "git clone https://github.com/A56-A5/openremote.git && cd openremote",
      "npm install && npm run build -w plugin",
    ],
  },
  {
    title: "2 · point it at the shared notebook",
    note: "copy-paste as-is — already filled in with this site's project.",
    cmds: [
      `node plugin/dist/cli.js config --url ${SUPA_URL} --key ${SUPA_KEY}`,
      "node plugin/dist/cli.js install   # adds /opencode-remote to OpenCode",
    ],
  },
  {
    title: "3 · wake up your agent",
    note: "in your project folder — the worker attaches to this server.",
    cmds: ["opencode serve"],
  },
  {
    title: "4 · go remote",
    note: "new terminal. prints your personal PAIRING CODE (valid 15 min).",
    cmds: ["node ~/.openremote/bin/openremote start", "opencode   # optional: your normal TUI, it joins the served instance"],
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
          computer</b> — each pairing is a private account, so 3–5 friends can share this site without
          seeing each other's agents (row-level security keeps notebooks separate). Same Supabase, same
          rate limits — fine at this size.
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
          Take the pairing code from step 4 → switch to the <b>pair</b> tab → paste it. Your sessions and
          activity show up live. Commands on your computer:{" "}
          <code>openremote status</code>, <code>openremote code</code> (fresh pairing code),{" "}
          <code>openremote stop</code>.
        </p>
      </div>
    </div>
  );
}
