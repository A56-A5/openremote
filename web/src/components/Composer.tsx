import { useRef, useState } from "react";

const MAX_CHARS = 20_000; // prompts.text check in the schema

export default function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    try {
      await onSend(value);
      setText("");
      taRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const tooLong = text.length > MAX_CHARS;

  return (
    <form className="note peach composer" onSubmit={send} style={{ position: "relative" }}>
      <span className="tape left" />
      <div className="hand" style={{ fontSize: "1.4rem", marginBottom: 6 }}>
        leave a note for your agent ✉
      </div>
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="dear agent…"
        maxLength={MAX_CHARS + 500}
      />
      <div className="row">
        <span className="hint" style={{ marginRight: "auto" }}>
          {tooLong ? "too long" : `${text.length}/${MAX_CHARS}`}
        </span>
        <button
          className="btn"
          type="submit"
          disabled={busy || !text.trim() || tooLong || disabled}
        >
          {busy ? "pinning…" : "pin to queue →"}
        </button>
      </div>
    </form>
  );
}
