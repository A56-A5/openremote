import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL as string) || "";
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || "";

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type Session = {
  id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
  status: "online" | "offline" | "busy";
  last_seen_at: string;
};

export type FeedEvent = {
  id: string;
  session_id: string;
  kind: "user_message" | "assistant_message" | "tool" | "error" | "status";
  role: string | null;
  content: string | null;
  tool_name: string | null;
  created_at: string;
};

export type Prompt = {
  id: string;
  session_id: string;
  text: string;
  status: string;
  created_at: string;
};
