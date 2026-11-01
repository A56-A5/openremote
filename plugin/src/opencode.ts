// Minimal OpenCode server client: REST + SSE.
// Endpoint and event names verified against @opencode-ai/sdk@1.18.18 types
// (dist/gen/types.gen.d.ts) and https://opencode.ai/docs/server.
import { spawn } from "node:child_process";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { backoffDelay } from "./backoff.js";
import { SERVE_PID_FILE, TUI_SERVER_FILE, ensureHome } from "./config.js";

export type OcEvent = {
  type: string;
  properties?: Record<string, unknown>;
  sessionID?: string;
};

export type OcPermission = {
  id: string;
  sessionID: string;
  title?: string;
  type?: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
  time?: { created?: number };
};

const COMMON_PORTS = [4096, 4097, 6123, 8080, 3000];

function authHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

function normalize(url: string): string {
  return url.replace(/\/$/, "");
}

async function ocFetch(
  base: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 5000, ...rest } = init;
  return fetch(`${normalize(base)}${path}`, {
    ...rest,
    headers: { ...authHeader(), ...(rest.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function healthCheck(base: string): Promise<boolean> {
  try {
    const res = await ocFetch(base, "/config", { timeoutMs: 1500 });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// session / prompt / permission REST
// ---------------------------------------------------------------------------

export type OcSession = {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  time?: { created?: number; updated?: number };
};

export async function listSessions(base: string): Promise<OcSession[]> {
  const res = await ocFetch(base, "/session", { timeoutMs: 5000 });
  if (!res.ok) throw new Error(`OpenCode /session failed: ${res.status}`);
  return (await res.json()) as OcSession[];
}

/** GET /session/status → { [sessionID]: { type: "idle" | "busy" | "retry", ... } } */
export async function sessionStatuses(
  base: string
): Promise<Record<string, { type: string; attempt?: number }>> {
  const res = await ocFetch(base, "/session/status", { timeoutMs: 5000 });
  if (!res.ok) throw new Error(`OpenCode /session/status failed: ${res.status}`);
  return (await res.json()) as Record<string, { type: string }>;
}

export type OcMessage = {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    error?: unknown;
  };
  parts: Array<{ type: string; text?: string; [k: string]: unknown }>;
};

export async function sessionMessages(
  base: string,
  sessionId: string,
  limit = 50
): Promise<OcMessage[]> {
  const res = await ocFetch(
    base,
    `/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`,
    { timeoutMs: 8000 }
  );
  if (!res.ok) throw new Error(`OpenCode messages failed: ${res.status}`);
  return (await res.json()) as OcMessage[];
}

/**
 * POST /session/{id}/prompt_async → 204. Returns as soon as OpenCode accepts
 * the prompt; delivery state in the DB is what the phone watches.
 */
export async function promptAsync(base: string, sessionId: string, text: string): Promise<void> {
  const res = await ocFetch(base, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
    timeoutMs: 15_000,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`prompt_async failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

/** POST /session/{id}/permissions/{permissionID} body { response: once|always|reject } */
export async function replyPermission(
  base: string,
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject"
): Promise<void> {
  const res = await ocFetch(
    base,
    `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
      timeoutMs: 10_000,
    }
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`permission reply failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// server discovery / managed serve
// ---------------------------------------------------------------------------

function readTuiServer(): string | null {
  try {
    if (!existsSync(TUI_SERVER_FILE)) return null;
    const parsed = JSON.parse(readFileSync(TUI_SERVER_FILE, "utf8")) as { url?: string; at?: number };
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

export function writeTuiServer(url: string): void {
  try {
    ensureHome();
    writeFileSync(TUI_SERVER_FILE, JSON.stringify({ url, at: Date.now() }), { mode: 0o600 });
  } catch {}
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function spawnServe(): Promise<{ url: string; pid: number }> {
  const port = await freePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  ensureHome();
  writeFileSync(SERVE_PID_FILE, String(child.pid), { mode: 0o600 });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 30; i++) {
    if (await healthCheck(url)) return { url, pid: child.pid! };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`opencode serve did not become healthy on ${url}`);
}

export type ResolvedServer = { url: string; spawned: boolean; pid?: number };

/**
 * 1. configured/env URL → 2. URL handed over by the TUI plugin → 3. common
 * local ports → 4. spawn a managed `opencode serve` bound to 127.0.0.1.
 * Never binds 0.0.0.0.
 */
export async function resolveServerUrl(configured?: string): Promise<ResolvedServer> {
  const candidates = [
    configured,
    process.env.OPENCODE_SERVER_URL,
    readTuiServer(),
    ...COMMON_PORTS.map((p) => `http://127.0.0.1:${p}`),
  ].filter((v): v is string => Boolean(v));

  const seen = new Set<string>();
  for (const raw of candidates) {
    const url = normalize(raw);
    if (seen.has(url)) continue;
    seen.add(url);
    if (await healthCheck(url)) return { url, spawned: false };
  }
  const spawned = await spawnServe();
  return { url: spawned.url, spawned: true, pid: spawned.pid };
}

// ---------------------------------------------------------------------------
// SSE event stream with reconnect (exponential backoff + jitter, cap 30s)
// ---------------------------------------------------------------------------

async function* readSse(
  base: string,
  signal: AbortSignal
): AsyncGenerator<OcEvent, void, unknown> {
  const res = await fetch(`${normalize(base)}/event`, {
    headers: { accept: "text/event-stream", ...authHeader() },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`OpenCode /event failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          yield JSON.parse(dataLine.slice(5).trim()) as OcEvent;
        } catch {
          // ignore malformed frames
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

export type EventStreamOptions = {
  signal?: AbortSignal;
  /** Called after a successful reconnect (not on the first connect). */
  onReconnect?: (attempt: number) => Promise<void> | void;
  /** Called before each retry - the moment to re-resolve/respawn the server. */
  onRetry?: (attempt: number) => Promise<void> | void;
  baseDelayMs?: number;
  capMs?: number;
  random?: () => number;
};

/**
 * Forever-stream over /event. Drops and reconnects with capped exponential
 * backoff + jitter; never gives up while `signal` is unset. `base` may be a
 * getter so the worker can hand over a newly spawned server URL.
 */
export async function* connectEvents(
  base: string | (() => string),
  opts: EventStreamOptions = {}
): AsyncGenerator<OcEvent, void, unknown> {
  const signal = opts.signal ?? new AbortController().signal;
  const resolveBase = typeof base === "function" ? base : () => base;
  let attempt = 0;

  while (!signal.aborted) {
    if (attempt > 0 && opts.onRetry) {
      try {
        await opts.onRetry(attempt);
      } catch {}
    }
    try {
      const stream = readSse(resolveBase(), signal);
      const first = await stream.next();
      if (first.done) throw new Error("event stream closed");
      if (attempt > 0 && opts.onReconnect) await opts.onReconnect(attempt);
      attempt = 0;
      yield first.value;
      for await (const ev of stream) yield ev;
      if (signal.aborted) return;
      throw new Error("event stream closed");
    } catch {
      if (signal.aborted) return;
      const delay = backoffDelay(attempt++, {
        baseMs: opts.baseDelayMs ?? 500,
        capMs: opts.capMs ?? 30_000,
        random: opts.random,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
