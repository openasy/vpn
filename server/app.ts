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
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
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
  ".json": "application/json",
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

type ProblemCode = "invalid-token" | "invalid-json" | "invalid-body" | "version-mismatch" | "not-found" | "internal-error";

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "version-mismatch": "Version mismatch",
  "not-found": "Not found",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

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

export function createApp({ db, version, serverToken, webDir, docsDir, openapi }: AppOptions) {
  const spec = openapi && JSON.stringify({ ...openapi, info: { ...(openapi.info as object), version } });
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

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
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
      if (!tokenMatches(req.headers.authorization, serverToken)) return (problem(res, 401, "invalid-token", "Send the VPN_SERVER_TOKEN as a bearer token."), path);
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return (problem(res, 400, "invalid-json", "The body must be JSON, at most 16 KiB."), path);
      }
      const { id, version: agentVersion, listen, openvpnRunning } = (body ?? {}) as Partial<Server>;
      if (
        typeof id !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ||
        typeof agentVersion !== "string" ||
        typeof openvpnRunning !== "boolean" ||
        (listen != null && (typeof listen !== "string" || !/^(udp|tcp)\/\d{1,5}$/.test(listen)))
      ) {
        return (problem(res, 422, "invalid-body", "Expected { id, version, listen?, openvpnRunning }."), path);
      }
      // ADR 0019: an agent always has the same version as its product.
      if (agentVersion !== version) {
        return (problem(res, 409, "version-mismatch", `vpn-server ${agentVersion} does not match vpn-manager ${version}; install vpn-server ${version}`), path);
      }
      upsertServer.run(id, agentVersion, listen ?? null, openvpnRunning ? 1 : 0, new Date().toISOString());
      return (json(res, 202, { status: "accepted" }), path);
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: req.url, status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
