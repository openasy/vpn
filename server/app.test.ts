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
    expect(await res.text()).toContain('openasy_build_info{product="vpn-manager",version="1.2.3"} 1');
  });

  it("sets security headers", async () => {
    const res = await fetch(`${base}/api/v1/version`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ product: "vpn-manager", version: "1.2.3" });
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
