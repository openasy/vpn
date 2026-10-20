import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import { VpnError, type ReportedSession, type Vpn } from "./vpn.ts";

export interface AppOptions {
  db: DatabaseSync;
  vpn: Vpn;
  version: string;
  /** Shared token the vpn-server servers send; their requests are refused when unset. */
  serverToken?: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /**
   * Deprecated: one shared token with the admin role, for scripts written before sign-in existed. Use an API token
   * from Settings instead; this one has no expiry and is not tied to a person.
   */
  adminToken?: string;
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
  configVersion: string | null;
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

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) => send(res, status, JSON.stringify(data), "application/json", headers);

type ProblemCode = "invalid-token" | "invalid-json" | "invalid-body" | "version-mismatch" | "not-found" | "conflict" | "not-configured" | "internal-error";

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "version-mismatch": "Version mismatch",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

class HttpProblem extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
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

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const kib = Math.round(limit / 1024);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpProblem(400, "invalid-json", `The body must be JSON, at most ${kib} KiB.`);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpProblem(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003), or "server" for vpn-server. */
type Access = "none" | "server" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest accepted body; 64 KiB by default. */
  bodyLimit?: number;
  handle: (ctx: Ctx) => unknown;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function parseSessions(value: unknown): ReportedSession[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10_000) throw new HttpProblem(422, "invalid-body", "sessions must be a list of at most 10000 entries.");
  return value.map((x: Partial<ReportedSession>) => {
    const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (
      typeof x?.cn !== "string" ||
      x.cn.length > 64 ||
      typeof x.realAddress !== "string" ||
      x.realAddress.length > 64 ||
      typeof x.vpnIp !== "string" ||
      !IPV4.test(x.vpnIp) ||
      !count(x.bytesIn) ||
      !count(x.bytesOut) ||
      typeof x.connectedAt !== "string" ||
      Number.isNaN(Date.parse(x.connectedAt))
    ) {
      throw new HttpProblem(422, "invalid-body", "Each session needs { cn, realAddress, vpnIp, bytesIn, bytesOut, connectedAt }.");
    }
    return { cn: x.cn, realAddress: x.realAddress, vpnIp: x.vpnIp, bytesIn: x.bytesIn!, bytesOut: x.bytesOut!, connectedAt: new Date(x.connectedAt).toISOString() };
  });
}

/** Sessions from a server that has not reported for this long are not shown: they may be gone. */
const SESSION_FRESH_MS = 60_000;

export function createApp({ db, vpn, version, auth, serverToken, adminToken, webDir, docsDir, openapi }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const listServers = db.prepare("SELECT id, version, listen, openvpn_running, config_version, last_seen FROM servers ORDER BY id");
  const countServers = db.prepare("SELECT COUNT(*) AS n FROM servers");
  const upsertServer = db.prepare(
    `INSERT INTO servers (id, version, listen, openvpn_running, config_version, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, listen = excluded.listen, openvpn_running = excluded.openvpn_running,
       config_version = excluded.config_version, last_seen = excluded.last_seen`,
  );

  const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const created = (res: ServerResponse, data: unknown) => (json(res, 201, data), undefined);
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "vpn", version }) },

    // Servers: vpn-server reports here and pulls its config.
    {
      method: "GET",
      path: "/api/v1/servers",
      auth: "viewer",
      handle: () => {
        const rows = listServers.all() as Array<{ id: string; version: string; listen: string | null; openvpn_running: number; config_version: string | null; last_seen: string }>;
        const servers: Server[] = rows.map((r) => ({ id: r.id, version: r.version, listen: r.listen, openvpnRunning: r.openvpn_running === 1, configVersion: r.config_version, lastSeen: r.last_seen }));
        return { servers };
      },
    },
    {
      method: "POST",
      path: "/api/v1/servers/heartbeat",
      auth: "server",
      bodyLimit: 1024 * 1024,
      handle: async ({ res, body }) => {
        const raw = await body();
        const { id, version: agentVersion, listen, openvpnRunning, configVersion } = raw as Partial<Server>;
        if (
          typeof id !== "string" ||
          !SERVER_ID.test(id) ||
          typeof agentVersion !== "string" ||
          typeof openvpnRunning !== "boolean" ||
          (listen != null && (typeof listen !== "string" || !/^(udp|tcp)\/\d{1,5}$/.test(listen))) ||
          (configVersion != null && typeof configVersion !== "string")
        ) {
          throw new HttpProblem(422, "invalid-body", "Expected { id, version, listen?, openvpnRunning, configVersion? }.");
        }
        // ADR 0019: vpn-server always has the same version as vpn.
        if (agentVersion !== version) throw new HttpProblem(409, "version-mismatch", `vpn-server ${agentVersion} does not match vpn ${version}; install vpn-server ${version}`);
        const sessions = parseSessions(raw.sessions);
        upsertServer.run(id, agentVersion, listen ?? null, openvpnRunning ? 1 : 0, configVersion ?? null, new Date().toISOString());
        vpn.recordSessions(id, sessions);
        // Sessions to end now; vpn-server also ends any session whose device is no longer in its config.
        json(res, 202, { status: "accepted", disconnect: vpn.pendingDisconnects(id) });
      },
    },
    {
      // vpn-server pulls what it must run (ADR 0022, 0023). ETag lets it skip unchanged configs.
      method: "GET",
      path: "/api/v1/servers/:id/config",
      auth: "server",
      handle: async ({ req, res, params }) => {
        const id = params[0]!;
        if (!SERVER_ID.test(id)) throw new HttpProblem(422, "invalid-body", "Server ids are lowercase letters, digits and dashes.");
        const config = await vpn.serverConfig(id);
        const etag = `"${config.version}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ...SECURITY_HEADERS, etag }).end();
          return;
        }
        json(res, 200, config, { etag, "cache-control": "no-store" });
      },
    },

    // Live sessions.
    { method: "GET", path: "/api/v1/sessions", auth: "viewer", handle: () => ({ sessions: vpn.listSessions(SESSION_FRESH_MS) }) },
    {
      method: "DELETE",
      path: "/api/v1/sessions/:server/:device",
      auth: "editor",
      handle: ({ res, params }) => {
        vpn.requestDisconnect(params[0]!, params[1]!);
        json(res, 202, { status: "accepted" });
      },
    },

    // People and their devices.
    { method: "GET", path: "/api/v1/people", auth: "viewer", handle: () => ({ people: vpn.listPeople() }) },
    { method: "POST", path: "/api/v1/people", auth: "editor", handle: async ({ res, body }) => created(res, vpn.createPerson(await body())) },
    { method: "GET", path: "/api/v1/people/:id", auth: "viewer", handle: ({ params }) => vpn.person(params[0]!) },
    { method: "PATCH", path: "/api/v1/people/:id", auth: "editor", handle: async ({ params, body }) => vpn.updatePerson(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/people/:id", auth: "admin", handle: ({ res, params }) => (vpn.deletePerson(params[0]!), noContent(res)) },
    { method: "GET", path: "/api/v1/people/:id/devices", auth: "viewer", handle: ({ params }) => ({ devices: vpn.listDevices(params[0]!) }) },
    { method: "POST", path: "/api/v1/people/:id/devices", auth: "editor", handle: async ({ res, params, body }) => created(res, await vpn.createDevice(params[0]!, await body())) },
    { method: "DELETE", path: "/api/v1/devices/:id", auth: "editor", handle: ({ params }) => vpn.revokeDevice(params[0]!) },

    // Groups and IP groups.
    { method: "GET", path: "/api/v1/groups", auth: "viewer", handle: () => ({ groups: vpn.listGroups() }) },
    { method: "POST", path: "/api/v1/groups", auth: "admin", handle: async ({ res, body }) => created(res, vpn.createGroup(await body())) },
    { method: "DELETE", path: "/api/v1/groups/:id", auth: "admin", handle: ({ res, params }) => (vpn.deleteGroup(params[0]!), noContent(res)) },
    { method: "GET", path: "/api/v1/ip-groups", auth: "viewer", handle: () => ({ ipGroups: vpn.listIpGroups() }) },
    { method: "POST", path: "/api/v1/ip-groups", auth: "admin", handle: async ({ res, body }) => created(res, vpn.createIpGroup(await body())) },
    { method: "GET", path: "/api/v1/ip-groups/:id", auth: "viewer", handle: ({ params }) => vpn.ipGroup(params[0]!) },
    { method: "PATCH", path: "/api/v1/ip-groups/:id", auth: "admin", handle: async ({ params, body }) => vpn.updateIpGroup(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/ip-groups/:id", auth: "admin", handle: ({ res, params }) => (vpn.deleteIpGroup(params[0]!), noContent(res)) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access) {
    if (access === "none") return;
    if (access === "server") {
      if (!serverToken) throw new HttpProblem(503, "not-configured", "Set VPN_SERVER_TOKEN on vpn to use this endpoint.");
      if (!tokenMatches(req.headers.authorization, serverToken)) throw new HttpProblem(401, "invalid-token", "Send VPN_SERVER_TOKEN as a bearer token.");
      return;
    }
    if (tokenMatches(req.headers.authorization, adminToken)) return;
    auth.authorize(req, access);
  }

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
      send(res, 200, renderMetrics(version, n, vpn.listSessions(SESSION_FRESH_MS).length), "text/plain; version=0.0.4");
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

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, params, body: () => readJson(req, r.bodyLimit) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) sendProblem(res, err);
        else if (err instanceof HttpProblem || err instanceof VpnError) problem(res, err.status, err.code, err.message);
        else throw err;
      }
      return r.path;
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
