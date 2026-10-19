import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";

export interface AppOptions {
  db: DatabaseSync;
  version: string;
  /** Shared token the vpn-server agent sends; heartbeats are refused when unset. */
  serverToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
}

interface Server {
  id: string;
  version: string;
  /** "udp/1194", "tcp/443"; null when the server's config file decides. */
  listen: string | null;
  openvpnRunning: boolean;
  lastSeen: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json") {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ db, version, serverToken, webDir }: AppOptions) {
  const listServers = db.prepare("SELECT id, version, listen, openvpn_running, last_seen FROM servers ORDER BY id");
  const countServers = db.prepare("SELECT COUNT(*) AS n FROM servers");
  const upsertServer = db.prepare(
    `INSERT INTO servers (id, version, listen, openvpn_running, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, listen = excluded.listen, openvpn_running = excluded.openvpn_running, last_seen = excluded.last_seen`,
  );

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      const { n } = countServers.get() as { n: number };
      send(res, 200, renderMetrics(version, n), "text/plain; version=0.0.4");
      return "/metrics";
    }

    if (path === "/api/v1/version" && req.method === "GET") {
      return (json(res, 200, { product: "vpn-manager", version }), "/api/v1/version");
    }

    if (path === "/api/v1/servers" && req.method === "GET") {
      const rows = listServers.all() as { id: string; version: string; listen: string | null; openvpn_running: number; last_seen: string }[];
      const servers: Server[] = rows.map((r) => ({ id: r.id, version: r.version, listen: r.listen, openvpnRunning: r.openvpn_running === 1, lastSeen: r.last_seen }));
      return (json(res, 200, { servers }), "/api/v1/servers");
    }

    if (path === "/api/v1/servers/heartbeat" && req.method === "POST") {
      if (!tokenMatches(req.headers.authorization, serverToken)) return (json(res, 401, { error: "invalid token" }), path);
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return (json(res, 400, { error: "invalid JSON body" }), path);
      }
      const { id, version: agentVersion, listen, openvpnRunning } = (body ?? {}) as Partial<Server>;
      if (
        typeof id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ||
        typeof agentVersion !== "string" ||
        typeof openvpnRunning !== "boolean" ||
        (listen != null && (typeof listen !== "string" || !/^(udp|tcp)\/\d{1,5}$/.test(listen)))
      ) {
        return (json(res, 422, { error: "expected { id, version, listen?, openvpnRunning }" }), path);
      }
      // ADR 0019: an agent always has the same version as its product.
      if (agentVersion !== version) {
        return (json(res, 409, { error: `vpn-server ${agentVersion} does not match vpn-manager ${version}; install vpn-server ${version}` }), path);
      }
      upsertServer.run(id, agentVersion, listen ?? null, openvpnRunning ? 1 : 0, new Date().toISOString());
      return (json(res, 202, { status: "accepted" }), path);
    }

    if (path.startsWith("/api/")) return (json(res, 404, { error: "not found" }), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      const file = normalize(join(webDir, path === "/" ? "index.html" : path));
      const inside = file.startsWith(normalize(webDir));
      try {
        if (!inside || !extname(file)) throw new Error("spa route");
        send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
      } catch {
        // Unknown paths fall back to the single-page app.
        send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      }
      return "/web";
    }

    json(res, 404, { error: "not found" });
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: req.url, status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
