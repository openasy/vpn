import "reflect-metadata";
import { createHmac, X509Certificate } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEK, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
});
afterAll(() => app.close());

const post = (path: string, body: unknown) => app.admin(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => app.admin(path, { method: "PATCH", body: JSON.stringify(body) });
const config = async () =>
  (await (await app.agent("/api/v1/servers/edge-1/config")).json()) as {
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

  it("is closed to everyone without sign-in when no admin token is configured", async () => {
    const closed = await startApp({ version: "1.2.3", adminToken: undefined });
    const res = await closed.admin("/api/v1/people");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "invalid-token" });
    expect(await (await fetch(`${closed.base}/api/v1/people`)).json()).toMatchObject({ code: "unauthenticated" });
    await closed.close();
  });
});

/** A browser: keeps cookies and sends the Origin header of the page. */
function browser(base: string) {
  const jar = new Map<string, string>();
  return async (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin: init.origin ?? base,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  };
}

/** The current RFC 6238 code for a base32 secret. */
function totpNow(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("sign-in and roles", () => {
  const PASSWORD = "correct horse battery staple";

  it("gives viewers, editors and admins what their role allows", async () => {
    const own = await startApp({ version: "1.2.3" });
    const o = browser(own.base);
    const token = new URL(own.auth.setupLink()!).searchParams.get("setup");
    await o("/api/v1/auth/setup", { body: { token, name: "Olivia", email: "owner@example.com", password: PASSWORD } });
    expect(await (await o("/api/v1/people")).json()).toMatchObject({ code: "mfa-setup-required" });
    const { secret } = (await (await o("/api/v1/auth/me/totp", { body: {} })).json()) as { secret: string };
    await o("/api/v1/auth/me/totp/confirm", { body: { code: totpNow(secret) } });
    expect((await o("/api/v1/groups", { body: { name: "Staff" } })).status).toBe(201);

    const member = async (email: string, role: string) => {
      const { link } = (await (await o("/api/v1/auth/members", { body: { email, role } })).json()) as { link: string };
      const b = browser(own.base);
      await b(`/api/v1/auth/links/${new URL(link).searchParams.get("link")}`, { body: { password: PASSWORD } });
      return b;
    };
    const viewer = await member("vic@example.com", "viewer");
    expect((await viewer("/api/v1/people")).status).toBe(200);
    expect((await viewer("/api/v1/people", { body: { name: "X", email: "x@example.com" } })).status).toBe(403);

    const editor = await member("ed@example.com", "editor");
    const person = (await (await editor("/api/v1/people", { body: { name: "Dana", email: "dana@example.com", groups: ["Staff"] } })).json()) as { id: string };
    expect((await editor(`/api/v1/people/${person.id}/devices`, { body: { name: "Laptop" } })).status).toBe(201);
    expect((await editor("/api/v1/ip-groups", { body: { name: "DB", networks: [{ cidr: "10.0.0.0/24" }] } })).status).toBe(403);
    expect((await editor(`/api/v1/people/${person.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await editor("/api/v1/groups", { body: { name: "X" }, origin: "https://evil.example" })).status).toBe(403);

    expect((await o(`/api/v1/people/${person.id}`, { method: "DELETE" })).status).toBe(204);
    await own.close();
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
      networks: [
        { cidr: "172.16.20.0/24", ports: "tcp/5432", note: "Postgres" },
        { cidr: "172.16.40.12/32", ports: "tcp/6379" },
      ],
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
    const person = (await (await noHost.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "A", email: "a@example.com" }) })).json()) as {
      id: string;
    };
    const res = await noHost.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toContain("VPN_PUBLIC_HOST");
    await noHost.close();
  });

  it("list every listener the servers report, UDP first", async () => {
    const a = await startApp({ version: "1.2.3" });
    for (const [id, listen] of [
      ["edge-1-tcp", "tcp/443"],
      ["edge-1", "udp/1194"],
    ]) {
      await a.agent("/api/v1/servers/heartbeat", { method: "POST", body: JSON.stringify({ id, version: "1.2.3", listen, openvpnRunning: true }) });
    }
    const person = (await (await a.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "B", email: "b@example.com" }) })).json()) as {
      id: string;
    };
    const { ovpn } = (await (await a.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) })).json()) as {
      ovpn: string;
    };
    expect(ovpn.match(/^remote .*$/gm)).toEqual(["remote vpn.example.com 1194 udp", "remote vpn.example.com 443 tcp-client"]);
    await a.close();
  });

  it("list each server at its own address, and leave out servers that never reported", async () => {
    const a = await startApp({ version: "1.2.3", publicHost: undefined });
    const servers = [
      ["ist-1", "ist.vpn.example.com", "tcp/443"],
      ["fra-1", "fra.vpn.example.com", "udp/1194"],
      ["ist-2", "ist.vpn.example.com", "udp/1194"],
      ["new-1", "new.vpn.example.com", null],
    ] as const;
    for (const [id, address, listen] of servers) {
      const { enrollToken } = (await (await a.admin("/api/v1/servers", { method: "POST", body: JSON.stringify({ id, address }) })).json()) as {
        enrollToken: string;
      };
      if (!listen) continue;
      const { secret } = (await (await fetch(`${a.base}/api/v1/servers/enroll`, { method: "POST", body: JSON.stringify({ token: enrollToken }) })).json()) as {
        secret: string;
      };
      await fetch(`${a.base}/api/v1/servers/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ id, version: "1.2.3", listen, openvpnRunning: true }),
      });
    }
    const person = (await (await a.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "C", email: "c@example.com" }) })).json()) as {
      id: string;
    };
    const { ovpn } = (await (await a.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) })).json()) as {
      ovpn: string;
    };
    expect(ovpn.match(/^remote .*$/gm)).toEqual([
      "remote fra.vpn.example.com 1194 udp",
      "remote ist.vpn.example.com 1194 udp",
      "remote ist.vpn.example.com 443 tcp-client",
    ]);
    await a.close();
  });
});

describe("sessions", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  let device: { id: string };
  const beat = (sessions: unknown, id = "edge-1") =>
    s.agent("/api/v1/servers/heartbeat", {
      method: "POST",
      body: JSON.stringify({ id, version: "1.2.3", listen: "udp/1194", openvpnRunning: true, sessions }),
    });
  const live = (cn: string, extra = {}) => ({
    cn,
    realAddress: "203.0.113.24:51820",
    vpnIp: "10.8.0.2",
    bytesIn: 1200,
    bytesOut: 34000,
    connectedAt: "2026-10-19T10:00:00Z",
    ...extra,
  });

  beforeAll(async () => {
    s = await startApp({ version: "1.2.3" });
    const person = (await (
      await s.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "Dana Kim", email: "dana@example.com" }) })
    ).json()) as { id: string };
    device = (
      (await (await s.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) })).json()) as {
        device: { id: string };
      }
    ).device;
  });
  afterAll(() => s.close());

  it("lists what servers report, with the person and device", async () => {
    expect((await beat([live(device.id)])).status).toBe(202);
    const { sessions } = (await (await s.admin("/api/v1/sessions")).json()) as { sessions: Array<Record<string, unknown>> };
    expect(sessions).toEqual([
      {
        serverId: "edge-1",
        deviceId: device.id,
        deviceName: "Laptop",
        personId: expect.any(String),
        personName: "Dana Kim",
        realAddress: "203.0.113.24:51820",
        vpnIp: "10.8.0.2",
        bytesIn: 1200,
        bytesOut: 34000,
        connectedAt: "2026-10-19T10:00:00.000Z",
      },
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

describe("internal names (ADR 0054)", () => {
  it("keep a domain that exists only inside when forwarding is off", async () => {
    const closed = await startApp({ version: "1.2.3", dnsDomain: "corp.internal", dnsForward: false });
    try {
      expect((await closed.vpn.serverConfig("edge-1")).dns).toEqual({ domain: "corp.internal", records: [], forward: false });
      expect(closed.vpn.internalNames().forward).toBe(false);
    } finally {
      await closed.close();
    }
  });

  it("leave the config as it was without a domain", async () => {
    const plain = await startApp({ version: "1.2.3" });
    try {
      const c = await plain.vpn.serverConfig("edge-1");
      expect(c).not.toHaveProperty("dns");
      expect(plain.vpn.internalNames()).toEqual({ domain: null, forward: true, names: [] });
      expect(() => plain.vpn.createInternalName({ name: "web", type: "A", value: "10.0.0.1" })).toThrow(/VPN_DNS_DOMAIN/);
    } finally {
      await plain.close();
    }
    await expect(startApp({ version: "1.2.3", dnsDomain: "Internal YR" })).rejects.toThrow(/VPN_DNS_DOMAIN/);
  });

  it("send the domain and its names, and the switch of each device", async () => {
    const own = await startApp({ version: "1.2.3", dnsDomain: "Internal.YR." });
    const { vpn } = own;
    try {
      expect(vpn.createInternalName({ name: "web", type: "A", value: "172.16.20.5" })).toMatchObject({ name: "web", fqdn: "web.internal.yr" });
      vpn.createInternalName({ name: "web.internal.yr", type: "AAAA", value: "fd00::5" });
      vpn.createInternalName({ name: "grafana", type: "CNAME", value: "web.internal.yr." });
      vpn.createInternalName({ name: "internal.yr", type: "A", value: "172.16.20.1" });
      // An alias stands alone, and a name has one record of each type.
      expect(() => vpn.createInternalName({ name: "web", type: "CNAME", value: "x.example.com" })).toThrow(/CNAME and another/);
      expect(() => vpn.createInternalName({ name: "grafana", type: "A", value: "172.16.20.6" })).toThrow(/CNAME and another/);
      expect(() => vpn.createInternalName({ name: "web", type: "A", value: "172.16.20.6" })).toThrow(/has an A record/);
      expect(() => vpn.createInternalName({ name: "@", type: "CNAME", value: "x.example.com" })).toThrow(/CNAME and another/);
      expect(() => vpn.createInternalName({ name: "web", type: "A", value: "fd00::5" })).toThrow(/IPv4/);
      expect(() => vpn.createInternalName({ name: "-web", type: "A", value: "10.0.0.1" })).toThrow(/not a name/);

      vpn.createGroup({ name: "Ops" });
      vpn.createGroup({ name: "Sales" });
      const ops = vpn.createIpGroup({ name: "Ops nets", networks: [{ cidr: "172.16.20.0/24" }], allowedGroups: ["Ops"] });
      vpn.createIpGroup({ name: "Sales nets", networks: [{ cidr: "172.16.30.0/24" }], allowedGroups: ["Sales"], internalNames: false });
      const dana = vpn.createPerson({ name: "Dana", email: "dana@example.com", groups: ["Ops"] });
      const sam = vpn.createPerson({ name: "Sam", email: "sam@example.com", groups: ["Ops", "Sales"] });
      const laptop = (await vpn.createDevice(dana.id, { name: "Laptop" })).device;
      const phone = (await vpn.createDevice(dana.id, { name: "Phone" })).device;
      const sams = (await vpn.createDevice(sam.id, { name: "Laptop" })).device;
      expect(vpn.updateDevice(phone.id, { internalNames: false })).toMatchObject({ internalNames: false });
      expect(() => vpn.updateDevice(phone.id, { internalNames: "no" })).toThrow(/true or false/);

      const c = await vpn.serverConfig("edge-1");
      expect(c.dns).toEqual({
        domain: "internal.yr",
        // Split-horizon by default: the domain's other names are public DNS's.
        forward: true,
        records: [
          { name: "internal.yr", type: "A", value: "172.16.20.1" },
          { name: "grafana.internal.yr", type: "CNAME", value: "web.internal.yr" },
          { name: "web.internal.yr", type: "A", value: "172.16.20.5" },
          { name: "web.internal.yr", type: "AAAA", value: "fd00::5" },
        ],
      });
      const dns = Object.fromEntries(c.clients.map((cl) => [cl.cn, cl.dns]));
      // On by default; off for a device turned off, and for one whose IP group turns it off.
      expect(dns).toEqual({ [laptop.id]: true, [phone.id]: false, [sams.id]: false });
      expect(vpn.ipGroup(ops.id).internalNames).toBe(true);
      vpn.updateIpGroup(ops.id, { internalNames: false });
      expect((await vpn.serverConfig("edge-1")).clients.find((cl) => cl.cn === laptop.id)!.dns).toBe(false);
      expect((await vpn.serverConfig("edge-1")).version).not.toBe(c.version);
    } finally {
      await own.close();
    }
  });
});

describe("the internal CA (ADR 0054)", () => {
  it("is made for the domain, can sign nothing else, and keeps no key it issues", async () => {
    const own = await startApp({ version: "1.2.3", dnsDomain: "internal.yr" });
    try {
      const { vpn, db } = own;
      const { root } = vpn.internalCa();
      const parsed = new x509.X509Certificate(root!.certificate);
      const constraints = parsed.extensions.find((e) => e.type === "2.5.29.30")!;
      expect(constraints.critical).toBe(true);
      expect(Buffer.from(constraints.value).includes(Buffer.from("internal.yr"))).toBe(true);
      expect(parsed.getExtension(x509.BasicConstraintsExtension)).toMatchObject({ ca: true, pathLength: 0 });

      const issued = await vpn.issueInternal({ names: ["Grafana.internal.yr.", "*.apps.internal.yr"] });
      const leaf = new X509Certificate(issued.certificate);
      expect(leaf.verify(new X509Certificate(root!.certificate).publicKey)).toBe(true);
      expect(leaf.subjectAltName).toBe("DNS:grafana.internal.yr, DNS:*.apps.internal.yr");
      expect(Date.parse(issued.notAfter) - Date.now()).toBeGreaterThan(89 * 864e5);
      // Two whole PEM blocks, as a web server reads them: the certificate, then the root.
      expect(issued.chain.match(/-----BEGIN CERTIFICATE-----\n[\s\S]+?\n-----END CERTIFICATE-----\n/g)).toHaveLength(2);
      expect(new X509Certificate(issued.chain.split(/(?<=-----END CERTIFICATE-----\n)/)[1]!).fingerprint256).toBe(root!.fingerprint);
      expect(issued.key.endsWith("-----END PRIVATE KEY-----\n")).toBe(true);
      expect(issued.key).toContain("PRIVATE KEY");
      expect(JSON.stringify(db.prepare("SELECT * FROM internal_certs").all())).not.toContain("PRIVATE KEY");
      expect(vpn.internalCa().certificates).toEqual([
        { serial: issued.serial, names: ["grafana.internal.yr", "*.apps.internal.yr"], notAfter: issued.notAfter, createdAt: expect.any(String) },
      ]);

      await expect(vpn.issueInternal({ names: ["www.example.com"] })).rejects.toThrow(/not a name under internal.yr/);
      await expect(vpn.issueInternal({ names: ["notinternal.yr"] })).rejects.toThrow(/not a name under/);
      await expect(vpn.issueInternal({ names: ["10.0.0.1"] })).rejects.toThrow(/not a name under/);
      await expect(vpn.issueInternal({ names: ["web.internal.yr"], days: 398 })).rejects.toThrow(/1 to 397/);
      await expect(vpn.issueInternal({ names: [] })).rejects.toThrow(/1 to 20/);
    } finally {
      await own.close();
    }
  });

  it("is made again for a new domain, and is not there without one", async () => {
    const plain = await startApp({ version: "1.2.3" });
    try {
      expect(plain.vpn.internalCa()).toEqual({ domain: null, root: null, certificates: [] });
      expect(plain.vpn.internalRootPem()).toBeUndefined();
      await expect(plain.vpn.issueInternal({ names: ["web.internal.yr"] })).rejects.toThrow(/VPN_DNS_DOMAIN/);
    } finally {
      await plain.close();
    }
    const first = await startApp({ version: "1.2.3", dnsDomain: "internal.yr" });
    await first.vpn.issueInternal({ names: ["web.internal.yr"] });
    const before = first.vpn.internalCa().root!.fingerprint;
    // The same database with another domain, as after changing VPN_DNS_DOMAIN.
    const { createVpn } = await import("./vpn.ts");
    const { createKeyring } = await import("./kek.ts");
    const again = createVpn(first.db, { network: "10.8.0.0/24", dnsDomain: "corp.internal", keyring: createKeyring(KEK) });
    await again.init();
    await first.close();
    const now = again.internalCa();
    expect(now.domain).toBe("corp.internal");
    expect(now.root!.fingerprint).not.toBe(before);
    expect(now.root!.subject).toContain("corp.internal");
    // What the old root issued is gone with it.
    expect(now.certificates).toEqual([]);
  });
});
