import "reflect-metadata";
import { X509Certificate } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
});
afterAll(() => app.close());

const post = (path: string, body: unknown) => app.admin(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => app.admin(path, { method: "PATCH", body: JSON.stringify(body) });
const config = async () => (await (await app.agent("/api/v1/servers/edge-1/config")).json()) as {
  version: string;
  ca: string;
  cert: string;
  crl: string;
  clients: Array<{ cn: string; ip: string; routes: string[]; fullTunnel: boolean; allow: Array<{ cidr: string; proto: string; ports: number[] }> }>;
};
const pemBlock = (text: string, tag: string) => text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];

describe("management API", () => {
  it("refuses requests without the admin token", async () => {
    expect((await fetch(`${app.base}/api/v1/people`)).status).toBe(401);
    expect((await app.agent("/api/v1/people")).status).toBe(401);
  });

  it("is closed when no admin token is configured", async () => {
    const closed = await startApp({ version: "1.2.3", adminToken: undefined });
    const res = await closed.admin("/api/v1/people");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not-configured" });
    await closed.close();
  });
});

describe("people, groups and devices", () => {
  let personId: string;
  let deviceId: string;
  let ovpn: string;

  it("creates groups, an IP group and a person", async () => {
    expect((await post("/api/v1/groups", { name: "Backend engineers" })).status).toBe(201);
    expect((await post("/api/v1/groups", { name: "Contractors" })).status).toBe(201);
    expect((await post("/api/v1/groups", { name: "Backend engineers" })).status).toBe(409);

    const ipGroup = await post("/api/v1/ip-groups", {
      name: "Production databases",
      networks: [{ cidr: "172.16.20.0/24", ports: "tcp/5432", note: "Postgres" }, { cidr: "172.16.40.12/32", ports: "tcp/6379" }],
      allowedGroups: ["Backend engineers"],
    });
    expect(ipGroup.status).toBe(201);
    expect((await post("/api/v1/ip-groups", { name: "Bad", networks: [{ cidr: "172.16.20.1/24" }] })).status).toBe(422);

    const res = await post("/api/v1/people", { name: "Dana Kim", email: "dana@example.com", groups: ["Backend engineers"] });
    expect(res.status).toBe(201);
    const person = (await res.json()) as { id: string; groups: string[]; status: string };
    expect(person).toMatchObject({ groups: ["Backend engineers"], status: "active" });
    personId = person.id;
    expect((await post("/api/v1/people", { name: "Dana", email: "DANA@example.com" })).status).toBe(409);
    expect((await post("/api/v1/people", { name: "X", email: "x", groups: [] })).status).toBe(422);
    expect((await post("/api/v1/people", { name: "Y", email: "y@example.com", groups: ["Nope"] })).status).toBe(422);
  });

  it("adds a device and returns a working client config once", async () => {
    const res = await post(`/api/v1/people/${personId}/devices`, { name: "Work laptop" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { device: { id: string; vpnIp: string }; ovpn: string };
    deviceId = body.device.id;
    ovpn = body.ovpn;
    expect(body.device.vpnIp).toBe("10.8.0.2");
    expect(ovpn).toContain("remote vpn.example.com 1194 udp");
    expect(ovpn).toContain("<tls-crypt>");

    const ca = new X509Certificate(pemBlock(ovpn, "ca")!);
    const cert = new X509Certificate(pemBlock(ovpn, "cert")!);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.subject).toBe(`CN=${deviceId}`);
    expect(pemBlock(ovpn, "key")).toContain("BEGIN PRIVATE KEY");

    // The private key is not stored: listing devices never returns it.
    const list = await (await app.admin(`/api/v1/people/${personId}/devices`)).text();
    expect(list).not.toContain("PRIVATE KEY");
    const second = (await (await post(`/api/v1/people/${personId}/devices`, { name: "Phone" })).json()) as { device: { vpnIp: string } };
    expect(second.device.vpnIp).toBe("10.8.0.3");
  });

  it("gives the server its certificate and each device's address and routes", async () => {
    const c = await config();
    const ca = new X509Certificate(c.ca);
    expect(new X509Certificate(c.cert).verify(ca.publicKey)).toBe(true);
    expect(new X509Certificate(c.cert).subject).toBe("CN=edge-1");
    expect(c.clients).toContainEqual({
      cn: deviceId,
      ip: "10.8.0.2",
      routes: ["172.16.20.0/24", "172.16.40.12/32"],
      fullTunnel: false,
      allow: [
        { cidr: "172.16.20.0/24", proto: "tcp", ports: [5432] },
        { cidr: "172.16.40.12/32", proto: "tcp", ports: [6379] },
      ],
    });

    const etag = (await app.agent("/api/v1/servers/edge-1/config")).headers.get("etag")!;
    expect((await app.agent("/api/v1/servers/edge-1/config", { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await fetch(`${app.base}/api/v1/servers/edge-1/config`)).status).toBe(401);
  });

  it("follows group changes: a full-tunnel group adds the default route", async () => {
    await post("/api/v1/ip-groups", { name: "Everything", fullTunnel: true, networks: [{ cidr: "0.0.0.0/0" }], allowedGroups: ["Contractors"] });
    await patch(`/api/v1/people/${personId}`, { groups: ["Backend engineers", "Contractors"] });
    expect((await config()).clients.find((c) => c.cn === deviceId)).toMatchObject({ fullTunnel: true });
  });

  it("drops a suspended person's devices from the server and refuses new ones", async () => {
    await patch(`/api/v1/people/${personId}`, { status: "suspended" });
    expect((await config()).clients).toHaveLength(0);
    expect((await post(`/api/v1/people/${personId}/devices`, { name: "Tablet" })).status).toBe(409);
    await patch(`/api/v1/people/${personId}`, { status: "active" });
    expect((await config()).clients).toHaveLength(2);
  });

  it("revokes a device: it leaves the server and enters the revocation list", async () => {
    const before = await config();
    const res = await app.admin(`/api/v1/devices/${deviceId}`, { method: "DELETE" });
    expect(((await res.json()) as { revokedAt: string | null }).revokedAt).not.toBeNull();
    const after = await config();
    expect(after.version).not.toBe(before.version);
    expect(after.clients.map((c) => c.cn)).not.toContain(deviceId);

    const serial = new X509Certificate(pemBlock(ovpn, "cert")!).serialNumber.toLowerCase();
    const crl = new x509.X509Crl(after.crl);
    expect(crl.entries.map((e) => e.serialNumber.toLowerCase())).toContain(serial);
  });

  it("signs the CRL again before it expires, even without new revocations", async () => {
    const first = new x509.X509Crl((await config()).crl);
    expect(first.nextUpdate!.getTime() - Date.now()).toBeGreaterThan(29 * 864e5);
    // Pretend the cached CRL was signed eight days ago.
    const row = app.db.prepare("SELECT value FROM settings WHERE key = 'crl'").get() as { value: string };
    const [key, , pem] = JSON.parse(row.value) as [string, number, string];
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'crl'").run(JSON.stringify([key, Date.now() - 8 * 864e5, pem]));
    const again = (await config()).crl;
    expect(again).not.toBe(pem);
    expect(new x509.X509Crl(again).entries).toHaveLength(first.entries.length);
  });

  it("keeps a deleted person's certificates revoked", async () => {
    expect((await app.admin(`/api/v1/people/${personId}`, { method: "DELETE" })).status).toBe(204);
    const c = await config();
    expect(c.clients).toHaveLength(0);
    expect(new x509.X509Crl(c.crl).entries).toHaveLength(2);
    expect((await app.admin(`/api/v1/people/${personId}`)).status).toBe(404);
  });
});

describe("client configs", () => {
  it("need VPN_PUBLIC_HOST", async () => {
    const noHost = await startApp({ version: "1.2.3", publicHost: undefined });
    const person = (await (await noHost.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "A", email: "a@example.com" }) })).json()) as { id: string };
    const res = await noHost.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain("VPN_PUBLIC_HOST");
    await noHost.close();
  });

  it("list every listener the servers report, UDP first", async () => {
    const a = await startApp({ version: "1.2.3" });
    for (const [id, listen] of [["edge-1-tcp", "tcp/443"], ["edge-1", "udp/1194"]]) {
      await a.agent("/api/v1/servers/heartbeat", { method: "POST", body: JSON.stringify({ id, version: "1.2.3", listen, openvpnRunning: true }) });
    }
    const person = (await (await a.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "B", email: "b@example.com" }) })).json()) as { id: string };
    const { ovpn } = (await (await a.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) })).json()) as { ovpn: string };
    expect(ovpn.match(/^remote .*$/gm)).toEqual(["remote vpn.example.com 1194 udp", "remote vpn.example.com 443 tcp-client"]);
    await a.close();
  });
});

describe("sessions", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  let device: { id: string };
  const beat = (sessions: unknown, id = "edge-1") =>
    s.agent("/api/v1/servers/heartbeat", { method: "POST", body: JSON.stringify({ id, version: "1.2.3", listen: "udp/1194", openvpnRunning: true, sessions }) });
  const live = (cn: string, extra = {}) => ({ cn, realAddress: "203.0.113.24:51820", vpnIp: "10.8.0.2", bytesIn: 1200, bytesOut: 34000, connectedAt: "2026-10-19T10:00:00Z", ...extra });

  beforeAll(async () => {
    s = await startApp({ version: "1.2.3" });
    const person = (await (await s.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "Dana Kim", email: "dana@example.com" }) })).json()) as { id: string };
    device = ((await (await s.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) })).json()) as { device: { id: string } }).device;
  });
  afterAll(() => s.close());

  it("lists what servers report, with the person and device", async () => {
    expect((await beat([live(device.id)])).status).toBe(202);
    const { sessions } = (await (await s.admin("/api/v1/sessions")).json()) as { sessions: Array<Record<string, unknown>> };
    expect(sessions).toEqual([
      { serverId: "edge-1", deviceId: device.id, deviceName: "Laptop", personId: expect.any(String), personName: "Dana Kim", realAddress: "203.0.113.24:51820", vpnIp: "10.8.0.2", bytesIn: 1200, bytesOut: 34000, connectedAt: "2026-10-19T10:00:00.000Z" },
    ]);
    expect(await (await fetch(`${s.base}/metrics`)).text()).toContain("openasy_vpn_sessions 1");
  });

  it("rejects malformed sessions", async () => {
    expect((await beat([live(device.id, { vpnIp: "nope" })])).status).toBe(422);
    expect((await beat("nope")).status).toBe(422);
  });

  it("hands a disconnect to the server once, and forgets it when the session is gone", async () => {
    expect((await s.admin(`/api/v1/sessions/edge-1/${device.id}`, { method: "DELETE" })).status).toBe(202);
    expect(((await (await beat([live(device.id)])).json()) as { disconnect: string[] }).disconnect).toEqual([device.id]);
    const after = (await (await beat([])).json()) as { disconnect: string[] };
    expect(after.disconnect).toEqual([]);
    expect(((await (await s.admin("/api/v1/sessions")).json()) as { sessions: unknown[] }).sessions).toEqual([]);
    expect((await s.admin(`/api/v1/sessions/edge-1/${device.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("hides sessions from servers that stopped reporting", async () => {
    await beat([live(device.id)], "edge-2");
    s.db.prepare("UPDATE servers SET last_seen = ? WHERE id = 'edge-2'").run(new Date(Date.now() - 5 * 60_000).toISOString());
    expect(((await (await s.admin("/api/v1/sessions")).json()) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("accepts a heartbeat with many sessions", async () => {
    const many = Array.from({ length: 2000 }, (_, i) => live(`cn-${i}`));
    expect((await beat(many)).status).toBe(202);
  });
});
