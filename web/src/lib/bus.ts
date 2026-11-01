// Tiny row-event bus: the ONE realtime channel lives in App.tsx and fans out
// postgres_changes payloads to whichever page is mounted. Keeps the phone to a
// single websocket (realtime budget) while pages stay decoupled.
export type RowEvent = {
  table: "sessions" | "messages" | "prompts" | "permissions" | "file_activity";
  type: "INSERT" | "UPDATE" | "DELETE";
  row: Record<string, unknown> & { id?: string; session_id?: string };
  old?: Record<string, unknown>;
};

type Fn = (e: RowEvent) => void;
const subs = new Set<Fn>();

export function onRow(fn: Fn): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function emitRow(e: RowEvent): void {
  for (const fn of subs) fn(e);
}
