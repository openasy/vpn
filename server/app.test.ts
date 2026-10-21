import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_TOKEN, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const TOKEN = SERVER_TOKEN;

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
  base = app.base;
});

afterAll(() => app.close());

const heartbeat = (body: unknown, token = TOKEN) =>
  fetch(`${base}/api/v1/servers/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("health and metrics", () => {
  it("answers liveness and readiness", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ status: "ready" });
  });

  it("exposes Prometheus metrics", async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain('openasy_build_info{product="vpn",version="1.2.3"} 1');
  });

  it("sets security headers", async () => {
    const res = await fetch(`${base}/api/v1/version`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ product: "vpn", version: "1.2.3" });
  });
});

describe("server heartbeat", () => {
  it("refuses a wrong token", async () => {
    expect((await heartbeat({ id: "edge-1", version: "1.2.3", openvpnRunning: true }, "nope")).status).toBe(401);
  });

  it("refuses an agent of another version", async () => {
    const res = await heartbeat({ id: "edge-1", version: "1.1.0", openvpnRunning: true });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 409, code: "version-mismatch", detail: expect.stringContaining("install vpn-server 1.2.3") });
  });

  it("validates the body", async () => {
    expect((await heartbeat({ id: "Bad Id", version: "1.2.3", openvpnRunning: true })).status).toBe(422);
  });

  it("rejects a malformed listen value", async () => {
    expect((await heartbeat({ id: "edge-1", version: "1.2.3", listen: "https", openvpnRunning: true })).status).toBe(422);
  });

  it("records the server and lists it", async () => {
    expect((await heartbeat({ id: "edge-1", version: "1.2.3", openvpnRunning: true })).status).toBe(202);
    expect((await heartbeat({ id: "edge-1-tcp", version: "1.2.3", listen: "tcp/443", openvpnRunning: true })).status).toBe(202);
    const { servers } = (await (await app.admin("/api/v1/servers")).json()) as { servers: unknown[] };
    expect(servers).toEqual([
      expect.objectContaining({ id: "edge-1", version: "1.2.3", listen: null, openvpnRunning: true }),
      expect.objectContaining({ id: "edge-1-tcp", listen: "tcp/443" }),
    ]);
    expect(await (await fetch(`${base}/metrics`)).text()).toContain("openasy_vpn_servers 2");
  });

  it("returns JSON 404 for unknown API paths", async () => {
    expect((await fetch(`${base}/api/v1/nope`)).status).toBe(404);
  });
});

describe("server enrolment", () => {
  type Added = { server: { id: string; status: string; address: string | null }; enrollToken: string; enrollExpiresAt: string };
  const add = async (body: unknown) => app.admin("/api/v1/servers", { method: "POST", body: JSON.stringify(body) });
  const enroll = (token: string) => fetch(`${base}/api/v1/servers/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const config = (id: string, token: string) => fetch(`${base}/api/v1/servers/${id}/config`, { headers: { authorization: `Bearer ${token}` } });
  const status = async (id: string) => ((await (await app.admin("/api/v1/servers")).json()) as { servers: Array<{ id: string; status: string; legacy: boolean }> }).servers.find((s) => s.id === id);

  it("adds a server that waits for its enrolment token", async () => {
    const res = await add({ id: "fra-1", address: "FRA.vpn.example.com" });
    expect(res.status).toBe(201);
    const added = (await res.json()) as Added;
    expect(added.server).toMatchObject({ id: "fra-1", address: "fra.vpn.example.com", status: "waiting-to-enrol" });
    expect(added.enrollToken).toMatch(/^ove_/);
    expect(await status("fra-1")).toMatchObject({ status: "waiting-to-enrol", legacy: false });
  });

  it("validates new servers", async () => {
    expect((await add({ id: "Bad Id" })).status).toBe(422);
    expect((await add({ id: "x-1", address: "not a host" })).status).toBe(422);
    expect((await add({ id: "fra-1" })).status).toBe(409);
    expect((await fetch(`${base}/api/v1/servers`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("trades the token for a secret once, and the secret speaks only for its server", async () => {
    const { enrollToken } = (await (await add({ id: "ist-1", address: "ist.vpn.example.com" })).json()) as Added;
    expect((await enroll("ove_wrong")).status).toBe(401);
    const res = await enroll(enrollToken);
    expect(res.status).toBe(200);
    const { serverId, secret } = (await res.json()) as { serverId: string; secret: string };
    expect(serverId).toBe("ist-1");
    expect(secret).toMatch(/^ovs_/);
    expect((await enroll(enrollToken)).status).toBe(401);

    expect((await heartbeat({ id: "ist-1", version: "1.2.3", listen: "udp/1194", openvpnRunning: true }, secret)).status).toBe(202);
    expect(await status("ist-1")).toMatchObject({ status: "online", legacy: false });
    expect((await config("ist-1", secret)).status).toBe(200);
    // Not another server's key, and not with the shared token once enrolled.
    expect((await config("edge-1", secret)).status).toBe(403);
    expect((await heartbeat({ id: "edge-1", version: "1.2.3", openvpnRunning: true }, secret)).status).toBe(403);
    expect((await config("ist-1", TOKEN)).status).toBe(403);
    expect((await heartbeat({ id: "ist-1", version: "1.2.3", openvpnRunning: true })).status).toBe(403);
  });

  it("refuses an expired token", async () => {
    const { enrollToken } = (await (await add({ id: "old-1" })).json()) as Added;
    app.db.prepare("UPDATE servers SET enroll_expires_at = ? WHERE id = 'old-1'").run(new Date(Date.now() - 1000).toISOString());
    expect((await enroll(enrollToken)).status).toBe(401);
  });

  it("enrols again with a new secret and certificate, and revokes the old one", async () => {
    const first = (await (await enroll(((await (await add({ id: "ams-1" })).json()) as Added).enrollToken)).json()) as { secret: string };
    const before = (await (await config("ams-1", first.secret)).json()) as { cert: string };
    const again = await app.admin("/api/v1/servers/ams-1/enroll-token", { method: "POST" });
    expect(again.status).toBe(200);
    const { enrollToken } = (await again.json()) as Added;
    expect((await config("ams-1", first.secret)).status).toBe(401);
    const second = (await (await enroll(enrollToken)).json()) as { secret: string };
    const after = (await (await config("ams-1", second.secret)).json()) as { cert: string };
    expect(after.cert).not.toBe(before.cert);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM revocations").get() as { n: number }).n).toBe(1);
  });

  it("moves a legacy server off the shared token when it is enrolled", async () => {
    expect(await status("edge-1")).toMatchObject({ legacy: true });
    const { enrollToken } = (await (await app.admin("/api/v1/servers/edge-1/enroll-token", { method: "POST" })).json()) as Added;
    expect((await heartbeat({ id: "edge-1", version: "1.2.3", openvpnRunning: true })).status).toBe(403);
    const { secret } = (await (await enroll(enrollToken)).json()) as { secret: string };
    expect((await heartbeat({ id: "edge-1", version: "1.2.3", openvpnRunning: true }, secret)).status).toBe(202);
    expect(await status("edge-1")).toMatchObject({ status: "online", legacy: false });
  });

  it("changes a server's address and removes it", async () => {
    const res = await app.admin("/api/v1/servers/fra-1", { method: "PATCH", body: JSON.stringify({ address: "203.0.113.10" }) });
    expect(await res.json()).toMatchObject({ address: "203.0.113.10" });
    expect((await app.admin("/api/v1/servers/missing", { method: "PATCH", body: "{}" })).status).toBe(404);
    expect((await app.admin("/api/v1/servers/fra-1", { method: "DELETE" })).status).toBe(204);
    expect(await status("fra-1")).toBeUndefined();
    expect((await app.admin("/api/v1/servers/fra-1", { method: "DELETE" })).status).toBe(404);
  });

  it("shows a server of another version", async () => {
    const { enrollToken } = (await (await add({ id: "lag-1" })).json()) as Added;
    const { secret } = (await (await enroll(enrollToken)).json()) as { secret: string };
    expect((await heartbeat({ id: "lag-1", version: "1.1.0", openvpnRunning: true }, secret)).status).toBe(409);
    expect(await status("lag-1")).toMatchObject({ status: "version-mismatch" });
  });
});

describe("other products", () => {
  it("lists the configured products to anyone signed in", async () => {
    const products = [{ id: "infrastructure", url: "https://infra.example.com" }];
    const linked = await startApp({ version: "1.2.3", products });
    expect(await (await linked.admin("/api/v1/products")).json()).toEqual({ products });
    expect((await fetch(`${linked.base}/api/v1/products`)).status).toBe(401);
    await linked.close();
  });
});
