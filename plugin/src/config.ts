import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from "node:fs";

export const HOME = join(homedir(), ".openremote");
export const PID_FILE = join(HOME, "worker.pid");
export const SERVE_PID_FILE = join(HOME, "serve.pid");
export const STATE_FILE = join(HOME, "state.json");
export const TUI_SERVER_FILE = join(HOME, "tui-server.json");

/** Session tokens live here, chmod 600 - never in state.json, never in the DB. */
export const CONFIG_DIR = join(homedir(), ".config", "openremote");
export const AUTH_FILE = join(CONFIG_DIR, "auth.json");

export const DEFAULT_WEB_URL = "https://openremote-link.vercel.app";

/** Reported in public.machines.version. */
export const PLUGIN_VERSION = "2.0.0";

export type StoredState = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Supabase anonymous user that owns this machine's rows. */
  ownerId?: string;
  /** Row id in public.machines. */
  machineId?: string;
  machineName?: string;
  serverUrl?: string;
  webUrl: string;
  retentionDays: number;
  /** Cap on synced sessions (top-level, updated within the last 7 days). */
  maxSessions: number;
};

export type StoredAuth = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  expiresAt?: number;
};

const DEFAULTS: StoredState = {
  supabaseUrl: process.env.OPENREMOTE_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.OPENREMOTE_SUPABASE_ANON_KEY ?? "",
  webUrl: process.env.OPENREMOTE_WEB_URL ?? DEFAULT_WEB_URL,
  retentionDays: 7,
  maxSessions: 1,
};

export function ensureHome(): void {
  mkdirSync(HOME, { recursive: true });
}

export function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string): Partial<T> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<T>;
  } catch {
    return null;
  }
}

export function loadState(): StoredState {
  ensureHome();
  const file = readJson<StoredState>(STATE_FILE) ?? {};
  return {
    ...DEFAULTS,
    ...file,
    supabaseUrl: file.supabaseUrl || DEFAULTS.supabaseUrl,
    supabaseAnonKey: file.supabaseAnonKey || DEFAULTS.supabaseAnonKey,
    webUrl: file.webUrl || DEFAULTS.webUrl,
    serverUrl: file.serverUrl || process.env.OPENCODE_SERVER_URL || undefined,
    retentionDays: file.retentionDays ?? DEFAULTS.retentionDays,
    maxSessions: file.maxSessions ?? DEFAULTS.maxSessions,
  };
}

export function saveState(state: StoredState): void {
  ensureHome();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadAuth(): StoredAuth | null {
  const file = readJson<StoredAuth>(AUTH_FILE);
  if (!file?.refreshToken || !file.userId) return null;
  return file as StoredAuth;
}

export function saveAuth(auth: StoredAuth): void {
  ensureConfigDir();
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  try {
    chmodSync(AUTH_FILE, 0o600);
  } catch {}
}

export function clearAuth(): void {
  try {
    unlinkSync(AUTH_FILE);
  } catch {}
}
