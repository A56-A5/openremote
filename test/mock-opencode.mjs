// Mock OpenCode server for local E2E: SSE event bus + message sink.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_OC_PORT || 4096);
const SESSION_ID = "mock-session-001";
const clients = new Set();
const received = [];

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("access-control-allow-origin", "*");

  if (url.pathname === "/config" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }

  if (url.pathname === "/session" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify([
        { id: SESSION_ID, title: "Mock build session", directory: "/tmp/mock-project", time: { updated: Date.now() } },
      ])
    );
  }

  if (url.pathname === "/event" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    clients.add(res);
    // greet with a fresh update so sync gets an immediate signal
    emit({ type: "session.updated", sessionID: SESSION_ID, properties: { info: { id: SESSION_ID, title: "Mock build session", directory: "/tmp/mock-project" } } });
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === `/session/${SESSION_ID}/message` && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    received.push(parsed);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    console.log(`[mock] message received: ${JSON.stringify((parsed.parts ?? []).map((p) => p.type))}`);
    // simulate the agent replying
    setTimeout(() => {
      emit({
        type: "message.updated",
        sessionID: SESSION_ID,
        properties: {
          info: { id: "m-user-1", role: "user" },
          parts: [{ type: "text", text: (parsed.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ") }],
        },
      });
      emit({
        type: "message.updated",
        sessionID: SESSION_ID,
        properties: { info: { id: "m-assistant-1", role: "assistant" }, parts: [{ type: "text", text: "Mock agent: handled remotely ✓" }] },
      });
      emit({
        type: "message.part.updated",
        sessionID: SESSION_ID,
        properties: { part: { type: "tool", tool: "bash", state: { status: "completed", title: "npm test → 12 passed" } } },
      });
    }, 400);
    return;
  }

  if (url.pathname === "/__received" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(received));
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => console.log(`[mock] opencode mock listening on http://localhost:${PORT} session=${SESSION_ID}`));
