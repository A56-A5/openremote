import { useRef, useState } from "react";
import { supabase, Session } from "../lib/supabase";

const MAX_MB = 8;

export default function Composer({
  sessions,
  activeSession,
  onSent,
}: {
  sessions: Session[];
  activeSession: string | null;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const sid = activeSession ?? sessions[0]?.id;
    if (!sid || (!text.trim() && files.length === 0)) return;
    setBusy(true);
    try {
      const { data: authData } = await supabase.auth.getSession();
      const session = authData.session;
      if (!session) throw new Error("not paired");
      const { data: prompt, error } = await supabase
        .from("prompts")
        .insert({ user_id: session.user.id, session_id: sid, text: text.trim() || "(image prompt)" })
        .select("id")
        .single();
      if (error) throw error;

      for (const f of files) {
        const path = `${session.user.id}/${prompt.id}/${Date.now()}-${f.name.replace(/[^\w.-]/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("openremote-attachments").upload(path, f, {
          contentType: f.type,
        });
        if (upErr) throw upErr;
        await supabase.from("attachments").insert({
          user_id: session.user.id,
          prompt_id: prompt.id,
          storage_path: path,
          mime: f.type,
        });
      }
      setText("");
      setFiles([]);
      onSent();
    } catch (err: any) {
      alert(`Could not send: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  function pick(filesList: FileList | null) {
    if (!filesList) return;
    const ok: File[] = [];
    for (const f of filesList) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_MB * 1024 * 1024) {
        alert(`${f.name} is bigger than ${MAX_MB}MB`);
        continue;
      }
      ok.push(f);
    }
    setFiles((prev) => [...prev, ...ok].slice(0, 6));
  }

  return (
    <form className="note peach composer" onSubmit={send} style={{ position: "relative" }}>
      <span className="tape left" />
      <div className="hand" style={{ fontSize: "1.4rem", marginBottom: 6 }}>
        leave a note for your agent ✉
      </div>
      {sessions.length > 1 && (
        <select
          className="field"
          style={{ marginBottom: 8, fontSize: "0.72rem" }}
          defaultValue={activeSession ?? ""}
          onChange={() => {}}
          value={activeSession ?? ""}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id}
            </option>
          ))}
        </select>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="dear agent…"
      />
      {files.length > 0 && (
        <div className="thumbs">
          {files.map((f, i) => (
            <div className="thumb" key={i}>
              <img src={URL.createObjectURL(f)} alt={f.name} />
              <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <button type="button" className="btn secondary" onClick={() => inputRef.current?.click()}>
          🖼 attach
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
        <button className="btn" type="submit" disabled={busy || (!text.trim() && !files.length)}>
          {busy ? "pinning…" : "pin to queue →"}
        </button>
      </div>
    </form>
  );
}
