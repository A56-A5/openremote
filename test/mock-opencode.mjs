// Mock OpenCode server (v2 API shapes) for local worker E2E.
// Verified against @opencode-ai/sdk v1.18.18:
//   GET  /config, /session, /session/status, /event (SSE)
//   GET  /session/:id/message?limit
//   POST /session/:id/prompt_async                       -> 204
//   POST /session/:id/permissions/:pid {response}        -> 204
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_OC_PORT || 4096);
export const SESSION_ID = "mock-session-001";

const clients = new Set();
const promptsReceived = [];
const permissionReplies = [];
const messages = []; // { info, parts }[]
let status = "idle";
let turn = 0;

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

function emitStatus(type) {
  status = type;
  emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type } } });
}

function emitMessageUpdated(info) {
  emit({ type: "message.updated", properties: { info } });
}

function emitTextPart(messageID, text) {
  emit({
    type: "message.part.updated",
    properties: { part: { id: `pt-${messageID}`, messageID, sessionID: SESSION_ID, type: "text", text } },
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function scriptTurn(userText) {
  const n = ++turn;
  const userId = `m-user-${n}`;
  const assistantId = `m-assistant-${n}`;
  const permId = `perm-${n}`;

  emitStatus("busy");

  const userMsg = {
    info: { id: userId, sessionID: SESSION_ID, role: "user", time: { created: Date.now() } },
    parts: [{ type: "text", text: userText }],
  };

  emitTextPart(userId, userText);
  emitMessageUpdated(userMsg.info);

  // tool activity → file_activity rows
  setTimeout(() => {
    emit({
      type: "message.part.updated",
      properties: {
        part: {
          id: `pt-tool-${n}`,
          messageID: assistantId,
          sessionID: SESSION_ID,
          type: "tool",
          tool: "edit",
          state: { status: "completed", input: { path: "src/app.ts" } },
        },
      },
    });
    emit({ type: "file.edited", properties: { file: "src/app.ts" } });
  }, 150);

  // permission gate: nothing completes until the reply lands
  setTimeout(() => {
    emit({
      type: "permission.updated",
      properties: {
        id: permId,
        sessionID: SESSION_ID,
        title: "Bash: npm test",
        type: "bash",
        pattern: "npm test",
        time: { created: Date.now() },
      },
    });
  }, 300);
}

function finishTurn(n, response) {
  const assistantId = `m-assistant-${n}`;
  const text = `Mock agent: handled remotely ✓ (permission: ${response})`;

  emit({
    type: "permission.replied",
    properties: { sessionID: SESSION_ID, permissionID: `perm-${n}`, response },
  });

  setTimeout(() => {
    emitTextPart(assistantId, text);
    emitMessageUpdated({
      id: assistantId,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: Date.now() - 200, completed: Date.now() },
    });
    emitStatus("idle");
    emit({ type: "session.idle", properties: { sessionID: SESSION_ID } });
  }, 200);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  res.setHeader("access-control-allow-origin", "*");

  if (path === "/config" && req.method === "GET") return json(res, 200, {});

  if (path === "/session" && req.method === "GET") {
    return json(res, 200, [
      {
        id: SESSION_ID,
        title: "Mock build session",
        directory: "/tmp/mock-project",
        time: { created: Date.now() - 3_600_000, updated: Date.now() },
      },
      { id: "mock-sub", parentID: SESSION_ID, title: "subagent", time: { updated: Date.now() } },
    ]);
  }

  if (path === "/session/status" && req.method === "GET") {
    return json(res, 200, { [SESSION_ID]: { type: status } });
  }

  if (path === "/event" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(res);
    emit({
      type: "session.updated",
      sessionID: SESSION_ID,
      properties: {
        info: { id: SESSION_ID, title: "Mock build session", directory: "/tmp/mock-project" },
      },
    });
    req.on("close", () => clients.delete(res));
    return;
  }

  let m = path.match(/^\/session\/([^/]+)\/message(?:\/?)$/);
  if (m && req.method === "GET") {
    return json(res, 200, messages);
  }

  m = path.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (m && req.method === "POST") {
    const body = await readBody(req);
    const text = (body.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
    promptsReceived.push({ sessionID: m[1], text, at: Date.now() });
    messages.push({
      info: { id: `m-user-${turn + 1}`, sessionID: m[1], role: "user", time: { created: Date.now() } },
      parts: [{ type: "text", text }],
    });
    console.log(`[mock] prompt_async(${m[1]}): ${JSON.stringify(text)}`);
    scriptTurn(text);
    res.writeHead(204).end();
    return;
  }

  m = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
  if (m && req.method === "POST") {
    const body = await readBody(req);
    const response = body.response ?? "once";
    const n = Number(m[2].split("-").pop()) || turn;
    permissionReplies.push({ permissionID: m[2], response, at: Date.now() });
    console.log(`[mock] permission ${m[2]} → ${response}`);
    messages.push({
      info: {
        id: `m-assistant-${n}`,
        sessionID: m[1],
        role: "assistant",
        time: { created: Date.now() - 200, completed: Date.now() },
      },
      parts: [
        { type: "text", text: `Mock agent: handled remotely ✓ (permission: ${response})` },
      ],
    });
    finishTurn(n, response);
    res.writeHead(204).end();
    return;
  }

  if (path === "/__received" && req.method === "GET") return json(res, 200, promptsReceived);
  if (path === "/__permissions" && req.method === "GET") return json(res, 200, permissionReplies);
  if (path === "/__status" && req.method === "GET") return json(res, 200, { status, clients: clients.size });

  res.writeHead(404).end();
});

server.listen(PORT, () =>
  console.log(`[mock] opencode mock listening on http://127.0.0.1:${PORT} session=${SESSION_ID}`)
);
