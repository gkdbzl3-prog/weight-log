import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 8080);
const publicDir = join(process.cwd(), "public");
const DATA_DIR = join(process.cwd(), "data");
const ROOMS_FILE = join(DATA_DIR, "rooms.json");
const SYNCS_FILE = join(DATA_DIR, "syncs.json");

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

// ---- Room storage ----
let rooms = {};

async function loadRooms() {
  try {
    const raw = await readFile(ROOMS_FILE, "utf-8");
    rooms = JSON.parse(raw);
  } catch {
    rooms = {};
  }
}

async function persistRooms() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(ROOMS_FILE, JSON.stringify(rooms), "utf-8");
  } catch {}
}

// ---- Sync storage (personal cross-device backup) ----
let syncs = {};

async function loadSyncs() {
  try {
    const raw = await readFile(SYNCS_FILE, "utf-8");
    syncs = JSON.parse(raw);
  } catch {
    syncs = {};
  }
}

async function persistSyncs() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SYNCS_FILE, JSON.stringify(syncs), "utf-8");
  } catch {}
}

// Merge entries by date — entry with the latest `ts` wins for the same date
function mergeEntries(a = [], b = []) {
  const map = new Map();
  for (const e of a) {
    if (e && e.date) map.set(e.date, e);
  }
  for (const e of b) {
    if (!e || !e.date) continue;
    const prev = map.get(e.date);
    if (!prev || (Number(e.ts) || 0) > (Number(prev.ts) || 0)) {
      map.set(e.date, e);
    }
  }
  return Array.from(map.values()).sort((x, y) => x.date.localeCompare(y.date));
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
    do { code = genCode(); attempts++; } while (rooms[code] && attempts < 20);
    rooms[code] = { created: Date.now(), slot1: null, slot2: null };
    persistRooms();
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
      const room = rooms[code];
      if (!room) return json(res, 404, { error: "방을 찾을 수 없어요" });
      return json(res, 200, { slot1: room.slot1, slot2: room.slot2 });
    }

    // POST /api/room/:code/join  →  join as slot2
    if (action === "join" && req.method === "POST") {
      const room = rooms[code];
      if (!room) return json(res, 404, { error: "방을 찾을 수 없어요" });
      const slot = !room.slot2 ? "slot2" : !room.slot1 ? "slot1" : null;
      if (!slot) return json(res, 409, { error: "이미 꽉 찼어요" });
      return json(res, 200, { slot });
    }

    // PUT /api/room/:code/slot1|slot2  →  update member delta (+ optionally append a new status)
    if ((action === "slot1" || action === "slot2") && req.method === "PUT") {
      const room = rooms[code];
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
        statuses.push({ text: newStatus, ts: Date.now() });
        if (statuses.length > 10) statuses = statuses.slice(-10);
      }
      room[action] = {
        name: String(body.name || existing.name || "").slice(0, 20),
        delta: typeof body.delta === "number" ? body.delta : (existing.delta || 0),
        statuses,
        updated: Date.now(),
      };
      persistRooms();
      return json(res, 200, { ok: true });
    }
  }

  // POST /api/sync  →  create new sync code
  if (pathname === "/api/sync" && req.method === "POST") {
    let code;
    let attempts = 0;
    do { code = genCode(); attempts++; } while (syncs[code] && attempts < 20);
    syncs[code] = {
      created: Date.now(),
      updated: Date.now(),
      entries: [],
      settings: {},
    };
    persistSyncs();
    return json(res, 200, { code });
  }

  if (parts[1] === "api" && parts[2] === "sync" && parts[3]) {
    const code = parts[3].toUpperCase();

    // GET /api/sync/:code  →  fetch synced data
    if (req.method === "GET") {
      const sync = syncs[code];
      if (!sync) return json(res, 404, { error: "동기화 코드를 찾을 수 없어요" });
      return json(res, 200, {
        entries: sync.entries || [],
        settings: sync.settings || {},
        updated: sync.updated,
      });
    }

    // PUT /api/sync/:code  →  merge client data, return merged result
    if (req.method === "PUT") {
      let sync = syncs[code];
      if (!sync) {
        // Auto-create if missing (allows manual code entry on fresh server)
        sync = syncs[code] = { created: Date.now(), updated: Date.now(), entries: [], settings: {} };
      }
      const body = await readBody(req);
      const incomingEntries = Array.isArray(body.entries) ? body.entries : [];
      const incomingSettings = body.settings && typeof body.settings === "object" ? body.settings : null;
      sync.entries = mergeEntries(sync.entries, incomingEntries);
      if (incomingSettings) sync.settings = { ...sync.settings, ...incomingSettings };
      sync.updated = Date.now();
      persistSyncs();
      return json(res, 200, {
        entries: sync.entries,
        settings: sync.settings,
        updated: sync.updated,
      });
    }
  }

  json(res, 404, { error: "not found" });
}

await loadRooms();
await loadSyncs();

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
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
