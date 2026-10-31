// Minimal OpenCode server REST + SSE client.

export type OcPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state?: { status?: string; title?: string; output?: string } }
  | { type: "file"; mime: string; filename?: string; url: string }
  | { type: string; [k: string]: unknown };

export type OcEvent = {
  type: string;
  sessionID?: string;
  properties?: Record<string, unknown>;
};

const COMMON_PORTS = [4096, 6123, 8080, 3000, 5173];

export async function detectServerUrl(configured?: string): Promise<string> {
  const candidates = [configured, process.env.OPENCODE_SERVER_URL, ...COMMON_PORTS.map((p) => `http://localhost:${p}`)]
    .filter((v): v is string => Boolean(v));
  for (const url of candidates) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/config`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return url.replace(/\/$/, "");
    } catch {}
  }
  throw new Error(
    "Could not find a running OpenCode server. Pass --server http://localhost:PORT or set OPENCODE_SERVER_URL."
  );
}

export async function listSessions(serverUrl: string): Promise<Array<{ id: string; title?: string; directory?: string; time?: {updated?: number} }>> {
  const res = await fetch(`${serverUrl}/session`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`OpenCode /session failed: ${res.status}`);
  return (await res.json()) as any;
}

export async function sendMessage(
  serverUrl: string,
  sessionID: string,
  parts: OcPart[],
  opts?: { model?: { providerID: string; modelID: string } }
): Promise<void> {
  const res = await fetch(`${serverUrl}/session/${encodeURIComponent(sessionID)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts, ...(opts?.model ? { model: opts.model } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenCode message failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

export async function* eventStream(serverUrl: string): AsyncGenerator<OcEvent> {
  const res = await fetch(`${serverUrl}/event`, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`OpenCode /event failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
      } catch {}
    }
  }
}
