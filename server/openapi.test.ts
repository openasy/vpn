import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, SERVER_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "vpn-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir, dnsDomain: "internal.yr" });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${path} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const json = (body: unknown, token = SERVER_TOKEN) => ({
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const admin = (body?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // vpn's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("heartbeat: accepted and every refusal", async () => {
    await call("POST", "/api/v1/servers/heartbeat", json({ id: "edge-1", version, listen: "tcp/443", openvpnRunning: true }));
    await call("POST", "/api/v1/servers/heartbeat", { ...json({}), headers: { authorization: "Bearer wrong" } });
    await call("POST", "/api/v1/servers/heartbeat", { ...json({}), body: "{not json" });
    await call("POST", "/api/v1/servers/heartbeat", json({ id: "Bad Id", version, openvpnRunning: true }));
    const { body } = await call("POST", "/api/v1/servers/heartbeat", json({ id: "edge-1", version: "0.0.1", openvpnRunning: true }));
    expect(body).toMatchObject({ status: 409, code: "version-mismatch" });
  });

  it("servers", async () => {
    const { body } = await call("GET", "/api/v1/servers", admin());
    expect((body as { servers: unknown[] }).servers).toHaveLength(1);
    await call("GET", "/api/v1/servers", {});
    const { res } = await call("GET", "/api/v1/servers/{id}/config", json(undefined), "/api/v1/servers/edge-1/config");
    await call(
      "GET",
      "/api/v1/servers/{id}/config",
      { headers: { ...json(undefined).headers, "if-none-match": res.headers.get("etag")! } },
      "/api/v1/servers/edge-1/config",
    );
    await call("GET", "/api/v1/servers/{id}/config", json(undefined), "/api/v1/servers/Bad_Id/config");
    await call("GET", "/api/v1/servers/{id}/config", {}, "/api/v1/servers/edge-1/config");
  });

  it("adding and enrolling servers", async () => {
    const added = (await call("POST", "/api/v1/servers", admin({ id: "fra-1", address: "fra.vpn.example.com" }))).body as { enrollToken: string };
    await call("POST", "/api/v1/servers", admin({ id: "fra-1" }));
    await call("POST", "/api/v1/servers", admin({ id: "Bad Id" }));
    await call("POST", "/api/v1/servers", { ...admin(), body: "nope" });
    await call("POST", "/api/v1/servers", {});
    await call("PATCH", "/api/v1/servers/{id}", admin({ address: null }), "/api/v1/servers/fra-1");
    await call("PATCH", "/api/v1/servers/{id}", admin({ address: "no way" }), "/api/v1/servers/fra-1");
    await call("PATCH", "/api/v1/servers/{id}", admin({}), "/api/v1/servers/missing");

    await call("POST", "/api/v1/servers/enroll", json({ token: "ove_wrong" }));
    await call("POST", "/api/v1/servers/enroll", { ...json({}), body: "nope" });
    const { secret } = (await call("POST", "/api/v1/servers/enroll", json({ token: added.enrollToken }))).body as { secret: string };
    await call("POST", "/api/v1/servers/heartbeat", json({ id: "fra-1", version, listen: "udp/1194", openvpnRunning: true }, secret));
    await call("POST", "/api/v1/servers/heartbeat", json({ id: "edge-1", version, openvpnRunning: true }, secret));
    await call("GET", "/api/v1/servers/{id}/config", json(undefined, secret), "/api/v1/servers/edge-1/config");
    await call("GET", "/api/v1/servers", admin());

    await call("POST", "/api/v1/servers/{id}/enroll-token", admin(), "/api/v1/servers/fra-1/enroll-token");
    await call("POST", "/api/v1/servers/{id}/enroll-token", admin(), "/api/v1/servers/missing/enroll-token");
    await call("DELETE", "/api/v1/servers/{id}", admin(), "/api/v1/servers/fra-1");
    await call("DELETE", "/api/v1/servers/{id}", admin(), "/api/v1/servers/fra-1");
  });

  it("people, devices, groups and IP groups", async () => {
    const group = (await call("POST", "/api/v1/groups", { method: "POST", ...admin({ name: "SRE on-call" }) })).body as { id: string };
    await call("POST", "/api/v1/groups", admin({ name: "SRE on-call" }));
    await call("POST", "/api/v1/groups", admin({ name: "" }));
    await call("POST", "/api/v1/groups", { ...admin(), body: "nope" });
    await call("GET", "/api/v1/groups", admin());

    const ip = (
      await call(
        "POST",
        "/api/v1/ip-groups",
        admin({ name: "Kubernetes API", networks: [{ cidr: "172.16.0.10/32", ports: "tcp/6443" }], allowedGroups: ["SRE on-call"] }),
      )
    ).body as { id: string };
    await call("POST", "/api/v1/ip-groups", admin({ name: "Kubernetes API" }));
    await call("POST", "/api/v1/ip-groups", admin({ name: "x", networks: [{ cidr: "nope" }] }));
    await call("POST", "/api/v1/ip-groups", { ...admin(), body: "nope" });
    await call("GET", "/api/v1/ip-groups", admin());
    await call("GET", "/api/v1/ip-groups/{id}", admin(), `/api/v1/ip-groups/${ip.id}`);
    await call("GET", "/api/v1/ip-groups/{id}", admin(), "/api/v1/ip-groups/missing");
    await call("PATCH", "/api/v1/ip-groups/{id}", admin({ fullTunnel: false }), `/api/v1/ip-groups/${ip.id}`);
    await call("PATCH", "/api/v1/ip-groups/{id}", admin({ fullTunnel: "yes" }), `/api/v1/ip-groups/${ip.id}`);
    await call("PATCH", "/api/v1/ip-groups/{id}", { ...admin(), body: "nope" }, `/api/v1/ip-groups/${ip.id}`);
    await call("PATCH", "/api/v1/ip-groups/{id}", admin({}), "/api/v1/ip-groups/missing");
    await call("PATCH", "/api/v1/ip-groups/{id}", admin({ internalNames: false }), `/api/v1/ip-groups/${ip.id}`);
    await call("PATCH", "/api/v1/ip-groups/{id}", admin({ internalNames: "no" }), `/api/v1/ip-groups/${ip.id}`);

    // Internal names (ADR 0054).
    const name = (await call("POST", "/api/v1/internal-names", admin({ name: "grafana", type: "A", value: "172.16.20.5" }))).body as { id: string };
    await call("POST", "/api/v1/internal-names", admin({ name: "grafana.internal.yr", type: "A", value: "172.16.20.6" }));
    await call("POST", "/api/v1/internal-names", admin({ name: "grafana", type: "CNAME", value: "web.internal.yr" }));
    await call("POST", "/api/v1/internal-names", admin({ name: "bad name", type: "A", value: "172.16.20.5" }));
    await call("POST", "/api/v1/internal-names", admin({ name: "web", type: "AAAA", value: "172.16.20.5" }));
    await call("POST", "/api/v1/internal-names", { ...admin(), body: "nope" });
    await call("GET", "/api/v1/internal-names", admin());
    await call("DELETE", "/api/v1/internal-names/{id}", admin(), `/api/v1/internal-names/${name.id}`);
    await call("DELETE", "/api/v1/internal-names/{id}", admin(), "/api/v1/internal-names/missing");

    // The internal CA (ADR 0054).
    await call("POST", "/api/v1/internal-ca/certificates", admin({ names: ["grafana.internal.yr", "*.apps.internal.yr"], days: 30 }));
    await call("POST", "/api/v1/internal-ca/certificates", admin({ names: ["www.example.com"] }));
    await call("POST", "/api/v1/internal-ca/certificates", admin({ names: ["web.internal.yr"], days: 900 }));
    await call("POST", "/api/v1/internal-ca/certificates", { ...admin(), body: "nope" });
    await call("GET", "/api/v1/internal-ca", admin());
    await call("GET", "/api/v1/internal-ca/root.crt");
    await call("GET", "/api/v1/internal-ca/root.crt", {}, "/api/v1/internal-ca/root.crt?format=der");
    await call("GET", "/api/v1/internal-ca/root.mobileconfig");
    const acmeKey = (await call("POST", "/api/v1/internal-ca/acme-keys", admin({ name: "Caddy on web-1" }))).body as { id: string };
    await call("POST", "/api/v1/internal-ca/acme-keys", admin({ name: "" }));
    await call("POST", "/api/v1/internal-ca/acme-keys", { ...admin(), body: "nope" });
    await call("GET", "/api/v1/internal-ca/acme-keys", admin());
    await call("DELETE", "/api/v1/internal-ca/acme-keys/{id}", admin(), `/api/v1/internal-ca/acme-keys/${acmeKey.id}`);
    await call("DELETE", "/api/v1/internal-ca/acme-keys/{id}", admin(), "/api/v1/internal-ca/acme-keys/missing");

    const person = (await call("POST", "/api/v1/people", admin({ name: "Sarah Chen", email: "sarah@example.com", groups: ["SRE on-call"] }))).body as {
      id: string;
    };
    await call("POST", "/api/v1/people", admin({ name: "Sarah", email: "sarah@example.com" }));
    await call("POST", "/api/v1/people", admin({ name: "No email" }));
    await call("POST", "/api/v1/people", { ...admin(), body: "nope" });
    await call("GET", "/api/v1/people", admin());
    await call("GET", "/api/v1/people/{id}", admin(), `/api/v1/people/${person.id}`);
    await call("GET", "/api/v1/people/{id}", admin(), "/api/v1/people/missing");
    await call("PATCH", "/api/v1/people/{id}", admin({ name: "Sarah C." }), `/api/v1/people/${person.id}`);
    await call("PATCH", "/api/v1/people/{id}", admin({ status: "gone" }), `/api/v1/people/${person.id}`);
    await call("PATCH", "/api/v1/people/{id}", { ...admin(), body: "nope" }, `/api/v1/people/${person.id}`);
    await call("PATCH", "/api/v1/people/{id}", admin({}), "/api/v1/people/missing");

    const device = (await call("POST", "/api/v1/people/{id}/devices", admin({ name: "Laptop" }), `/api/v1/people/${person.id}/devices`)).body as {
      device: { id: string };
    };
    await call("POST", "/api/v1/people/{id}/devices", admin({}), `/api/v1/people/${person.id}/devices`);
    await call("POST", "/api/v1/people/{id}/devices", { ...admin(), body: "nope" }, `/api/v1/people/${person.id}/devices`);
    await call("POST", "/api/v1/people/{id}/devices", admin({ name: "Laptop" }), "/api/v1/people/missing/devices");
    await call("PATCH", "/api/v1/people/{id}", admin({ status: "suspended" }), `/api/v1/people/${person.id}`);
    await call("POST", "/api/v1/people/{id}/devices", admin({ name: "Phone" }), `/api/v1/people/${person.id}/devices`);
    await call("GET", "/api/v1/people/{id}/devices", admin(), `/api/v1/people/${person.id}/devices`);
    await call("GET", "/api/v1/people/{id}/devices", admin(), "/api/v1/people/missing/devices");
    await call("PATCH", "/api/v1/devices/{id}", admin({ internalNames: false }), `/api/v1/devices/${device.device.id}`);
    await call("PATCH", "/api/v1/devices/{id}", admin({ internalNames: "off" }), `/api/v1/devices/${device.device.id}`);
    await call("PATCH", "/api/v1/devices/{id}", { ...admin(), body: "nope" }, `/api/v1/devices/${device.device.id}`);
    await call("PATCH", "/api/v1/devices/{id}", admin({}), "/api/v1/devices/missing");
    await call("DELETE", "/api/v1/devices/{id}", admin(), `/api/v1/devices/${device.device.id}`);
    await call("DELETE", "/api/v1/devices/{id}", admin(), "/api/v1/devices/missing");

    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person.id}`);
    await call("DELETE", "/api/v1/people/{id}", admin(), "/api/v1/people/missing");
    await call("DELETE", "/api/v1/ip-groups/{id}", admin(), `/api/v1/ip-groups/${ip.id}`);
    await call("DELETE", "/api/v1/ip-groups/{id}", admin(), "/api/v1/ip-groups/missing");
    await call("DELETE", "/api/v1/groups/{id}", admin(), `/api/v1/groups/${group.id}`);
    await call("DELETE", "/api/v1/groups/{id}", admin(), "/api/v1/groups/missing");

    // Every management endpoint answers 401 without the token; check one per method.
    for (const [m, p] of [
      ["GET", "/api/v1/people"],
      ["POST", "/api/v1/people"],
      ["GET", "/api/v1/groups"],
      ["POST", "/api/v1/groups"],
      ["GET", "/api/v1/ip-groups"],
      ["POST", "/api/v1/ip-groups"],
    ] as const)
      await call(m, p, { method: m });
  });

  it("sessions", async () => {
    const person = (await call("POST", "/api/v1/people", admin({ name: "Zoe Adams", email: "zoe@example.com" }))).body as { id: string };
    const device = (
      (await call("POST", "/api/v1/people/{id}/devices", admin({ name: "Phone" }), `/api/v1/people/${person.id}/devices`)).body as { device: { id: string } }
    ).device;
    const session = { cn: device.id, realAddress: "198.51.100.7:1194", vpnIp: "10.8.0.9", bytesIn: 1, bytesOut: 2, connectedAt: new Date().toISOString() };
    await call("POST", "/api/v1/servers/heartbeat", json({ id: "edge-1", version, listen: "udp/1194", openvpnRunning: true, sessions: [session] }));
    expect(((await call("GET", "/api/v1/sessions", admin())).body as { sessions: unknown[] }).sessions).toHaveLength(1);
    await call("DELETE", "/api/v1/sessions/{server}/{device}", admin(), `/api/v1/sessions/edge-1/${device.id}`);
    await call("DELETE", "/api/v1/sessions/{server}/{device}", admin(), "/api/v1/sessions/edge-1/missing");
    await call("GET", "/api/v1/sessions", {});
  });

  it("refuses everything when tokens are not configured", async () => {
    const closed = await startApp({ version, openapi: spec, adminToken: undefined, serverToken: undefined });
    const was = base;
    base = closed.base;
    await call("GET", "/api/v1/people", admin());
    await call("POST", "/api/v1/servers/heartbeat", json({ id: "edge-1", version, openvpnRunning: true }));
    base = was;
    await closed.close();
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
