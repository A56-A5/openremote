// Minimal Supabase stand-in (PostgREST + GoTrue subset) so the REAL
// @supabase/supabase-js client can run the worker offline in tests.
// Covers exactly the surface openremote v2 uses:
//   auth:  POST /auth/v1/signup (anonymous), /auth/v1/token?grant_type=refresh_token
//   rest:  GET/POST/PATCH/DELETE /rest/v1/<table>
//            filters col=op.value (eq, neq, gt, gte, lt, lte, is, in, like)
//            select, order=col.desc, limit, offset, on_conflict,
//            Prefer: return=representation / resolution=merge-duplicates
//          POST /rest/v1/rpc/<fn>
// No RLS here - row security is proven by supabase/tests/rls_test.sql.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.FAKE_SUPABASE_PORT || 54321);

const PKS = {
  machines: ["id"],
  sessions: ["id"],
  messages: ["id"],
  prompts: ["id"],
  permissions: ["id"],
  links: ["owner_id", "viewer_id"],
  pairings: ["id"],
  pairing_failures: ["id"],
  file_activity: ["session_id", "path"],
};

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "apikey"]);
const tables = new Map(Object.keys(PKS).map((k) => [k, []]));
const refreshTokens = new Map(); // refresh_token → user id
const pairings = new Map(); // plaintext code → row (fake: no bcrypt)

function rows(table) {
  if (!tables.has(table)) tables.set(table, []);
  return tables.get(table);
}

function jwtFor(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: uid,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.fakesig`;
}

function uidFrom(req) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub ?? null;
  } catch {
    return null;
  }
}

function send(res, status, body) {
  if (status === 204 || body === undefined) return res.writeHead(204).end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function pgError(res, status, message, code = "P0001") {
  send(res, status, { message, code, details: "", hint: "" });
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const wantsRepresentation = (req) => String(req.headers.prefer ?? "").includes("return=representation");
const wantsObject = (req) => String(req.headers.accept ?? "").includes("application/vnd.pgrst.object+json");

function scalarEq(a, b) {
  if (a === null || a === undefined) return b === "null" || b === null;
  return String(a) === String(b);
}

function matches(row, col, op, value) {
  const v = row[col];
  switch (op) {
    case "eq":
      return scalarEq(v, value);
    case "neq":
      return !scalarEq(v, value);
    case "gt":
      return String(v ?? "") > String(value ?? "");
    case "gte":
      return String(v ?? "") >= String(value ?? "");
    case "lt":
      return String(v ?? "") < String(value ?? "");
    case "lte":
      return String(v ?? "") <= String(value ?? "");
    case "is":
      if (value === "null") return v === null || v === undefined;
      if (value === "true") return v === true;
      if (value === "false") return v === false;
      return scalarEq(v, value);
    case "in": {
      const inner = value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value;
      const list = inner.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      return list.includes(String(v));
    }
    case "like": {
      const re = new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`);
      return re.test(String(v ?? ""));
    }
    default:
      return false;
  }
}

function applyFilters(input, params) {
  let out = input;
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key)) continue;
    const dot = raw.indexOf(".");
    if (dot === -1) continue;
    out = out.filter((r) => matches(r, key, raw.slice(0, dot), raw.slice(dot + 1)));
  }
  return out;
}

function applySelect(input, select) {
  if (!select || select === "*") return input;
  const cols = select.split(",").map((s) => s.trim());
  return input.map((row) => {
    const picked = {};
    for (const c of cols) {
      if (c.includes("(")) continue;
      if (Object.prototype.hasOwnProperty.call(row, c)) picked[c] = row[c];
    }
    return picked;
  });
}

function applyOrder(input, order) {
  if (!order) return input;
  const [colSpec, dir] = order.split(".");
  const desc = dir?.startsWith("desc");
  return [...input].sort((a, b) => {
    const x = a[colSpec];
    const y = b[colSpec];
    if (x === y) return 0;
    if (x === undefined || x === null) return 1;
    if (y === undefined || y === null) return -1;
    const cmp = x < y ? -1 : 1;
    return desc ? -cmp : cmp;
  });
}

function pkOf(table, row) {
  const cols = PKS[table] ?? ["id"];
  return cols.map((c) => String(row[c])).join("\u0000");
}

function insertRows(table, body, params, uid, headersPrefer = "") {
  const list = Array.isArray(body) ? body : [body];
  const conflict = params.get("on_conflict");
  const ignore = String(headersPrefer).includes("resolution=ignore-duplicates");
  const merge = String(headersPrefer).includes("resolution=merge-duplicates");
  const stored = rows(table);
  const affected = [];

  for (const incoming of list) {
    const row = { ...incoming };
    if (row.id === undefined && PKS[table]?.includes("id")) row.id = randomUUID();
    if (row.created_at === undefined) row.created_at = new Date().toISOString();
    if (row.owner_id === undefined && row.session_id !== undefined && table !== "links") {
      // prompts/permissions/messages/file_activity rows carry owner_id in prod;
      // tests that forget it get the caller's identity (RLS-equivalent intent)
      if (uid) row.owner_id = uid;
    }

    if (conflict && merge) {
      const keys = conflict.split(",");
      const idx = stored.findIndex((r) => keys.every((k) => scalarEq(r[k], row[k])));
      if (idx >= 0) {
        if (ignore) continue;
        stored[idx] = { ...stored[idx], ...row };
        affected.push(stored[idx]);
        continue;
      }
    } else if (conflict && ignore) {
      const keys = conflict.split(",");
      if (stored.some((r) => keys.every((k) => scalarEq(r[k], row[k])))) continue;
    }
    stored.push(row);
    affected.push(row);
  }
  return affected;
}

// ---------------------------------------------------------------------------
// RPCs (mirrors of the SQL in supabase/migrations/*_openremote_v2.sql)
// ---------------------------------------------------------------------------

const rpcs = {
  claim_prompts(body, uid) {
    if (!uid) return { status: 401, error: "not authenticated" };
    const machine = rows("machines").find(
      (m) => m.id === body.p_machine_id && m.owner_id === uid
    );
    if (!machine) return { status: 400, error: "unknown machine" };

    const now = Date.now();
    for (const p of rows("prompts")) {
      if (
        p.owner_id === uid &&
        p.status === "sending" &&
        p.lease_until &&
        Date.parse(p.lease_until) < now
      ) {
        p.status = "failed";
        p.error = "unknown, retry?";
        p.claimed_by = null;
        p.lease_until = null;
      }
    }

    const limit = Math.max(Number(body.p_limit ?? 5), 1);
    const lease = Math.max(Number(body.p_lease_seconds ?? 30), 5);
    const pending = rows("prompts")
      .filter((p) => p.owner_id === uid && p.status === "pending")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, limit);

    const claimed = pending.map((p) => {
      p.status = "sending";
      p.claimed_by = body.p_machine_id;
      p.lease_until = new Date(now + lease * 1000).toISOString();
      p.attempts = (p.attempts ?? 0) + 1;
      return { id: p.id, session_id: p.session_id, text: p.text };
    });
    return { status: 200, body: claimed };
  },

  decide_permission(body, uid) {
    if (!uid) return { status: 401, error: "not authenticated" };
    if (!["allowed_once", "allowed_always", "denied"].includes(body.p_decision))
      return { status: 400, error: "invalid decision" };
    const row = rows("permissions").find((p) => p.id === body.p_id && p.status === "pending");
    if (
      !row ||
      !(
        row.owner_id === uid ||
        rows("links").some((l) => l.owner_id === row.owner_id && l.viewer_id === uid)
      )
    )
      return { status: 400, error: "permission not pending" };
    row.status = body.p_decision;
    row.decided_at = new Date().toISOString();
    return {
      status: 200,
      body: [{ session_id: row.session_id, opencode_permission_id: row.opencode_permission_id }],
    };
  },

  retry_prompt(body, uid) {
    if (!uid) return { status: 401, error: "not authenticated" };
    const row = rows("prompts").find(
      (p) =>
        p.id === body.p_id &&
        p.status === "failed" &&
        (p.owner_id === uid ||
          rows("links").some((l) => l.owner_id === p.owner_id && l.viewer_id === uid))
    );
    if (!row) return { status: 200, body: null };
    row.status = "pending";
    row.error = null;
    row.claimed_by = null;
    row.lease_until = null;
    row.attempts = 0;
    return { status: 200, body: row.id };
  },

  cleanup_pairing_failures(_body, uid) {
    if (!uid) return { status: 401, error: "not authenticated" };
    const cutoff = Date.now() - 86_400_000;
    const t = rows("pairing_failures");
    for (let i = t.length - 1; i >= 0; i--) if (Date.parse(t[i].at) < cutoff) t.splice(i, 1);
    return { status: 204 };
  },

  unlink(body, uid) {
    if (!uid) return { status: 401, error: "not authenticated" };
    const t = rows("links");
    const idx = t.findIndex(
      (l) => l.viewer_id === body.p_viewer_id && (l.owner_id === uid || l.viewer_id === uid)
    );
    if (idx === -1) return { status: 200, body: false };
    t.splice(idx, 1);
    return { status: 200, body: true };
  },

  create_pairing(_body, uid) {
    if (!uid) return { status: 401, error: "not authenticated" };
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const code = Array.from({ length: 8 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join("");
    const expires = new Date(Date.now() + 600_000).toISOString();
    const row = {
      id: randomUUID(),
      owner_id: uid,
      code_hash: code, // fake stores plaintext; prod stores bcrypt (SQL tests cover that)
      expires_at: expires,
      used_at: null,
      attempts: 0,
      created_at: new Date().toISOString(),
    };
    rows("pairings").push(row);
    pairings.set(code, row);
    return {
      status: 200,
      body: [{ code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expires }],
    };
  },

  claim_pairing(body, uid) {
    if (!uid) return { status: 200, body: [{ status: "unauthorized", owner_id: null }] };
    const norm = String(body.p_code ?? "")
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, "")
      .replace(/[IL]/g, "1")
      .replace(/O/g, "0");
    if (norm.length !== 8)
      return { status: 200, body: [{ status: "invalid", owner_id: null }] };
    const fails = rows("pairing_failures").filter(
      (f) => f.viewer_id === uid && Date.parse(f.at) > Date.now() - 600_000
    ).length;
    if (fails >= 5) return { status: 200, body: [{ status: "throttled", owner_id: null }] };

    const row = pairings.get(norm);
    const fail = () => {
      rows("pairing_failures").push({ id: randomUUID(), viewer_id: uid, at: new Date().toISOString() });
      return [{ status: "invalid", owner_id: null }];
    };
    if (!row) return { status: 200, body: fail() };
    if (row.used_at) return { status: 200, body: [{ status: "used", owner_id: null }] };
    if (Date.parse(row.expires_at) <= Date.now())
      return { status: 200, body: [{ status: "expired", owner_id: null }] };

    row.used_at = new Date().toISOString();
    const link = { owner_id: row.owner_id, viewer_id: uid, created_at: new Date().toISOString() };
    if (!rows("links").some((l) => l.owner_id === link.owner_id && l.viewer_id === uid)) {
      rows("links").push(link);
    }
    return { status: 200, body: [{ status: "ok", owner_id: row.owner_id }] };
  },
};

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[fake] handler error:", e);
    if (!res.headersSent) pgError(res, 500, String(e?.message ?? e), "XX000");
    else res.end();
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const uid = uidFrom(req);

  // --- test control surface ----------------------------------------------
  if (path === "/__rows") {
    const table = url.searchParams.get("table");
    const out = {};
    for (const [k, v] of tables) out[k] = v.length;
    if (table && tables.has(table)) return send(res, 200, tables.get(table));
    return send(res, 200, out);
  }
  if (path === "/__reset") {
    for (const t of tables.values()) t.length = 0;
    refreshTokens.clear();
    pairings.clear();
    return send(res, 204);
  }
  if (path === "/__seed" && method === "POST") {
    const body = await readBody(req);
    const t = rows(body.table);
    for (const r of body.rows ?? []) insertRows(body.table, r, url.searchParams, uid);
    return send(res, 200, { seeded: (body.rows ?? []).length, total: t.length });
  }

  // --- GoTrue --------------------------------------------------------------
  if (path.startsWith("/auth/v1/")) {
    if (path === "/auth/v1/signup" && method === "POST") {
      const id = randomUUID();
      const refresh = `rt_${randomUUID()}`;
      refreshTokens.set(refresh, id);
      const nowIso = new Date().toISOString();
      return send(res, 200, {
        access_token: jwtFor(id),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: refresh,
        user: {
          id,
          aud: "authenticated",
          role: "authenticated",
          email: "",
          phone: "",
          app_metadata: {},
          user_metadata: {},
          identities: [],
          created_at: nowIso,
          updated_at: nowIso,
          is_anonymous: true,
        },
      });
    }
    if (path === "/auth/v1/token" && method === "POST") {
      const body = (await readBody(req)) ?? {};
      const known = refreshTokens.get(body.refresh_token);
      if (!known) return pgError(res, 400, "invalid refresh token", "invalid_grant");
      const refresh = `rt_${randomUUID()}`;
      refreshTokens.delete(body.refresh_token);
      refreshTokens.set(refresh, known);
      const nowIso = new Date().toISOString();
      return send(res, 200, {
        access_token: jwtFor(known),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: refresh,
        user: {
          id: known,
          aud: "authenticated",
          role: "authenticated",
          email: "",
          app_metadata: {},
          user_metadata: {},
          identities: [],
          created_at: nowIso,
          updated_at: nowIso,
          is_anonymous: true,
        },
      });
    }
    if (path === "/auth/v1/logout") return send(res, 204);
    return pgError(res, 404, `unknown auth route ${path}`);
  }

  // --- PostgREST -----------------------------------------------------------
  if (path.startsWith("/rest/v1/")) {
    const rest = path.slice("/rest/v1/".length);
    const parts = rest.split("/").filter(Boolean);
    const params = url.searchParams;
    const body = ["POST", "PATCH"].includes(method) ? await readBody(req) : undefined;

    if (parts[0] === "rpc" && parts[1]) {
      const fn = rpcs[parts[1]];
      if (!fn) return pgError(res, 404, `function public.${parts[1]} does not exist`, "PGRST202");
      const result = fn(body ?? {}, uid);
      if (result.error) return pgError(res, result.status, result.error);
      if (result.status === 204) return send(res, 204);
      return send(res, 200, result.body);
    }

    const table = parts[0];
    if (!tables.has(table)) return pgError(res, 404, `relation ${table} does not exist`, "42P01");

    if (method === "GET") {
      let out = applyFilters(rows(table), params);
      out = applyOrder(out, params.get("order"));
      const offset = Number(params.get("offset") ?? 0);
      const limit = params.get("limit");
      if (offset) out = out.slice(offset);
      if (limit) out = out.slice(0, Number(limit));
      out = applySelect(out, params.get("select"));
      if (wantsObject(req)) {
        if (out.length === 1) return send(res, 200, out[0]);
        return pgError(
          res,
          406,
          "JSON object requested, multiple (or no) rows returned",
          "PGRST116"
        );
      }
      return send(res, 200, out);
    }

    if (method === "POST") {
      const affected = insertRows(
        table,
        body,
        params,
        uid,
        String(req.headers.prefer ?? "")
      );
      if (wantsRepresentation(req)) return send(res, 201, affected);
      return send(res, 204);
    }

    if (method === "PATCH") {
      const matched = applyFilters(rows(table), params);
      for (const row of matched) Object.assign(row, body);
      if (wantsRepresentation(req)) return send(res, 200, matched);
      return send(res, 204);
    }

    if (method === "DELETE") {
      const stored = rows(table);
      const doomed = applyFilters(stored, params);
      const doomedSet = new Set(doomed);
      const kept = stored.filter((r) => !doomedSet.has(r));
      stored.length = 0;
      stored.push(...kept);
      if (wantsRepresentation(req)) return send(res, 200, doomed);
      return send(res, 204);
    }

    return pgError(res, 405, `method ${method} not allowed`);
  }

  if (path === "/realtime/v1/websocket") {
    // supabase-js probes realtime over websocket; no server here → the worker
    // logs CHANNEL_ERROR and relies on REST polling (which the test exercises)
    return send(res, 404, "no realtime in fake-supabase");
  }

  return send(res, 404, { message: `unknown route ${path}` });
}

server.listen(PORT, () =>
  console.log(`[fake] supabase stand-in on http://127.0.0.1:${PORT} (rest + auth)`)
);
