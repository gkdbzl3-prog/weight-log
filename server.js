import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 8080);
const publicDir = join(process.cwd(), "public");
const FIREBASE_PROJECT_ID = "weight-log-9e860";
const FIREBASE_API_KEY = "AIzaSyDpmmoDqNt7E60amZK3EtTLMS-aIF7D8Qw";
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function resolvePath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  } catch {
    pathname = new URL(url, "http://localhost").pathname;
  }
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  return join(publicDir, safePath === "/" ? "index.html" : safePath);
}

// ---- Firestore storage ----
function docUrl(collection, id) {
  return `${FIRESTORE_BASE}/${collection}/${encodeURIComponent(id)}?key=${FIREBASE_API_KEY}`;
}

function encodeDoc(data) {
  return { fields: { payload: { stringValue: JSON.stringify(data) } } };
}

function decodeDoc(doc) {
  const raw = doc?.fields?.payload?.stringValue;
  if (!raw) return null;
  return JSON.parse(raw);
}

async function readDoc(collection, id) {
  const res = await fetch(docUrl(collection, id));
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[Firestore READ ${collection}/${id}] ${res.status}: ${detail.slice(0, 300)}`);
    throw new Error(`Firestore read failed: ${res.status}`);
  }
  return decodeDoc(await res.json());
}

async function writeDoc(collection, id, data) {
  // updateMask=payload tells Firestore explicitly: only the `payload` field is being updated.
  // Without it, behavior on missing-doc PATCH is less predictable.
  const url = `${docUrl(collection, id)}&updateMask.fieldPaths=payload`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeDoc(data)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[Firestore WRITE ${collection}/${id}] ${res.status}: ${detail.slice(0, 300)}`);
    throw new Error(`Firestore write failed: ${res.status}`);
  }
}

// Union of entries — deduped by ts so multiple records per day are preserved.
function mergeEntries(a = [], b = []) {
  const map = new Map();
  const keyOf = (e) => e.ts != null ? `t:${e.ts}` : `d:${e.date}`;
  for (const e of [...a, ...b]) {
    if (!e || !e.date) continue;
    map.set(keyOf(e), e);
  }
  return Array.from(map.values()).sort((x, y) => {
    const t1 = Number(x.ts) || 0;
    const t2 = Number(y.ts) || 0;
    if (t1 !== t2) return t1 - t2;
    return (x.date || "").localeCompare(y.date || "");
  });
}

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleApi(req, res, pathname) {
  // POST /api/room  →  create room
  if (pathname === "/api/room" && req.method === "POST") {
    let code;
    let attempts = 0;
    do { code = genCode(); attempts++; } while (await readDoc("rooms", code) && attempts < 20);
    await writeDoc("rooms", code, { created: Date.now(), slot1: null, slot2: null });
    return json(res, 200, { code, slot: "slot1" });
  }

  const parts = pathname.split("/");
  // /api/room/:code        → parts[3] = code
  // /api/room/:code/join   → parts[3] = code, parts[4] = 'join'
  // /api/room/:code/slot1  → parts[3] = code, parts[4] = 'slot1'
  if (parts[1] === "api" && parts[2] === "room" && parts[3]) {
    const code = parts[3].toUpperCase();
    const action = parts[4];

    // GET /api/room/:code  →  fetch room data
    if (!action && req.method === "GET") {
      const room = await readDoc("rooms", code);
      if (!room) return json(res, 404, { error: "방을 찾을 수 없어요" });
      return json(res, 200, { slot1: room.slot1, slot2: room.slot2 });
    }

    // POST /api/room/:code/join  →  join as slot2
    if (action === "join" && req.method === "POST") {
      const room = await readDoc("rooms", code);
      if (!room) return json(res, 404, { error: "방을 찾을 수 없어요" });
      const slot = !room.slot2 ? "slot2" : !room.slot1 ? "slot1" : null;
      if (!slot) return json(res, 409, { error: "이미 꽉 찼어요" });
      return json(res, 200, { slot });
    }

    // PUT /api/room/:code/slot1|slot2  →  update member delta (+ optionally append a new status)
    if ((action === "slot1" || action === "slot2") && req.method === "PUT") {
      const room = await readDoc("rooms", code);
      if (!room) return json(res, 404, { error: "방 없음" });
      const body = await readBody(req);
      const existing = room[action] || {};
      // Migrate legacy single-status field, if present
      let statuses = Array.isArray(existing.statuses) ? existing.statuses.slice() : [];
      if (!statuses.length && existing.status) {
        statuses.push({ text: String(existing.status).slice(0, 60), ts: existing.updated || Date.now() });
      }
      const newStatus = typeof body.status === "string" ? body.status.trim().slice(0, 60) : "";
      if (newStatus) {
        statuses.push({
          text: newStatus,
          ts: Date.now(),
          delta: typeof body.delta === "number" ? body.delta : null,
        });
        if (statuses.length > 10) statuses = statuses.slice(-10);
      }
      room[action] = {
        name: String(body.name || existing.name || "").slice(0, 20),
        delta: typeof body.delta === "number" ? body.delta : (existing.delta || 0),
        statuses,
        updated: Date.now(),
      };
      await writeDoc("rooms", code, room);
      return json(res, 200, { ok: true });
    }
  }

  // POST /api/sync  →  create new sync code
  if (pathname === "/api/sync" && req.method === "POST") {
    let code;
    let attempts = 0;
    do { code = genCode(); attempts++; } while (await readDoc("syncs", code) && attempts < 20);
    await writeDoc("syncs", code, {
      created: Date.now(),
      updated: Date.now(),
      entries: [],
      settings: {},
    });
    return json(res, 200, { code });
  }

  if (parts[1] === "api" && parts[2] === "sync" && parts[3]) {
    const code = parts[3].toUpperCase();

    // GET /api/sync/:code  →  fetch synced data
    if (req.method === "GET") {
      const sync = await readDoc("syncs", code);
      if (!sync) return json(res, 404, { error: "동기화 코드를 찾을 수 없어요" });
      return json(res, 200, {
        entries: sync.entries || [],
        settings: sync.settings || {},
        partnerRoom: sync.partnerRoom || null,
        updated: sync.updated,
      });
    }

    // PUT /api/sync/:code  →  merge client data, return merged result
    if (req.method === "PUT") {
      let sync = await readDoc("syncs", code);
      if (!sync) {
        // Auto-create if missing (allows manual code entry on fresh server)
        sync = { created: Date.now(), updated: Date.now(), entries: [], settings: {} };
      }
      const body = await readBody(req);
      const incomingEntries = Array.isArray(body.entries) ? body.entries : [];
      const incomingSettings = body.settings && typeof body.settings === "object" ? body.settings : null;
      sync.entries = mergeEntries(sync.entries, incomingEntries);
      if (incomingSettings) sync.settings = { ...sync.settings, ...incomingSettings };
      if ("partnerRoom" in body) {
        sync.partnerRoom = body.partnerRoom && typeof body.partnerRoom === "object"
          ? {
              code: String(body.partnerRoom.code || "").slice(0, 12),
              slot: String(body.partnerRoom.slot || "").slice(0, 12),
              name: String(body.partnerRoom.name || "").slice(0, 20),
            }
          : null;
      }
      sync.updated = Date.now();
      await writeDoc("syncs", code, sync);
      return json(res, 200, {
        entries: sync.entries,
        settings: sync.settings,
        partnerRoom: sync.partnerRoom || null,
        updated: sync.updated,
      });
    }
  }

  json(res, 404, { error: "not found" });
}

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;

    if (pathname.startsWith("/api/")) {
      try {
        await handleApi(req, res, pathname);
      } catch (err) {
        console.error(`[API ${req.method} ${pathname}]`, err);
        json(res, 500, { error: "server error", detail: String(err?.message || err) });
      }
      return;
    }

    const filePath = resolvePath(req.url || "/");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": types[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    const data = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(data);
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`weight-room listening on ${port}`);
});
