import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const HOME = join(homedir(), ".openremote");
export const PID_FILE = join(HOME, "worker.pid");
export const STATE_FILE = join(HOME, "state.json");

export type StoredState = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseSecretKey?: string;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  email?: string;
  accountPassword?: string;
  serverUrl?: string;
  retentionDays: number;
};

const DEFAULTS: StoredState = {
  supabaseUrl: process.env.OPENREMOTE_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.OPENREMOTE_SUPABASE_ANON_KEY ?? "",
  retentionDays: 7,
};

export function ensureHome(): void {
  mkdirSync(HOME, { recursive: true });
}

export function loadState(): StoredState {
  ensureHome();
  let file: Partial<StoredState> = {};
  if (existsSync(STATE_FILE)) {
    try {
      file = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      file = {};
    }
  }
  return {
    ...DEFAULTS,
    ...file,
    supabaseUrl: file.supabaseUrl || DEFAULTS.supabaseUrl,
    supabaseAnonKey: file.supabaseAnonKey || DEFAULTS.supabaseAnonKey,
    serverUrl: file.serverUrl || process.env.OPENCODE_SERVER_URL || undefined,
    retentionDays: file.retentionDays ?? 7,
  };
}

export function saveState(state: StoredState): void {
  ensureHome();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}
