import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL as string) || "";
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || "";

if (!url || !key) {
  throw new Error(
    "OpenRemote: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example)."
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type MachineRow = {
  id: string;
  owner_id: string;
  name: string;
  version: string | null;
  last_heartbeat: string | null;
  created_at: string;
};

export type SessionStatus = "working" | "needs_you" | "done" | "error";

export type SessionRow = {
  id: string;
  machine_id: string;
  owner_id: string;
  title: string | null;
  directory: string | null;
  status: SessionStatus;
  status_since: string;
  updated_at: string;
  created_at: string;
};

export type MessageRow = {
  id: string;
  session_id: string;
  owner_id: string;
  role: "user" | "assistant";
  text: string;
  truncated: boolean;
  created_at: string;
};

export type PromptStatus = "pending" | "sending" | "delivered" | "failed";

export type PromptRow = {
  id: string;
  session_id: string;
  owner_id: string;
  text: string;
  status: PromptStatus;
  attempts: number;
  claimed_by: string | null;
  lease_until: string | null;
  error: string | null;
  created_at: string;
};

export type PermissionStatus =
  | "pending"
  | "allowed_once"
  | "allowed_always"
  | "denied"
  | "resolved_locally"
  | "expired";

export type PermissionRow = {
  id: string;
  session_id: string;
  owner_id: string;
  opencode_permission_id: string;
  tool: string | null;
  title: string | null;
  detail: Record<string, unknown>;
  status: PermissionStatus;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
};

export type FileActivityRow = {
  session_id: string;
  owner_id: string;
  path: string;
  edit_count: number;
  last_op: "created" | "edited" | "deleted";
  first_at: string;
  last_at: string;
};

/** Machine heartbeat is 60s; anything older than this reads as offline. */
export const ONLINE_WINDOW_MS = 150_000;

export function isOnline(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return false;
  return Date.now() - Date.parse(lastHeartbeat) < ONLINE_WINDOW_MS;
}

export function newId(): string {
  return crypto.randomUUID();
}
