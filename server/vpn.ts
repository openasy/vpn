// The VPN's data: people, groups, IP groups, devices and what each vpn-server must run.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { clientAddresses, formatCidr, formatIp, parseCidr, parseIp, parsePorts, type Cidr } from "./net.ts";
import { crl, createCa, issue, tlsCryptKey, type Ca } from "./pki.ts";

export class VpnError extends Error {
  readonly status: number;
  readonly code: "invalid-body" | "not-found" | "conflict";
  constructor(status: number, code: "invalid-body" | "not-found" | "conflict", message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (m: string) => new VpnError(422, "invalid-body", m);
const notFound = (what: string) => new VpnError(404, "not-found", `${what} does not exist.`);
const now = () => new Date().toISOString();
const CRL_REFRESH = 7 * 864e5;

export interface Person {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  groups: string[];
  devices: number;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  people: number;
}

export interface IpNetwork {
  cidr: string;
  ports: string;
  note: string;
}

export interface IpGroup {
  id: string;
  name: string;
  fullTunnel: boolean;
  networks: IpNetwork[];
  allowedGroups: string[];
}

export interface Device {
  id: string;
  personId: string;
  name: string;
  vpnIp: string;
  notAfter: string;
  createdAt: string;
  revokedAt: string | null;
}

/** What one OpenVPN server runs. The agent applies it and reports `version` back. */
export interface ServerConfig {
  version: string;
  network: string;
  ca: string;
  cert: string;
  key: string;
  crl: string;
  tlsCrypt: string;
  clients: Array<{ cn: string; ip: string; routes: string[]; fullTunnel: boolean }>;
}

export interface VpnOptions {
  /** Address pool for clients, for example 10.8.0.0/24. */
  network: string;
  /** Host name or IP clients connect to; required to download a client config. */
  publicHost?: string;
}

export function createVpn(db: DatabaseSync, opts: VpnOptions) {
  const network = parseCidr(opts.network);
  if (!network || network.prefix > 29) throw new Error(`VPN_NETWORK must be an IPv4 network of /29 or larger, not "${opts.network}"`);

  const setting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const putSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const get = (key: string) => (setting.get(key) as { value: string } | undefined)?.value;

  /** Creates the CA and tls-crypt key on first start. */
  async function init() {
    if (!get("ca_cert")) {
      const ca = await createCa();
      putSetting.run("ca_cert", ca.cert);
      putSetting.run("ca_key", ca.key);
    }
    if (!get("tls_crypt")) putSetting.run("tls_crypt", tlsCryptKey());
  }

  const ca = (): Ca => ({ cert: get("ca_cert")!, key: get("ca_key")! });

  // ---- groups -------------------------------------------------------------

  function groupIds(names: unknown): string[] {
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw invalid("groups must be a list of group names.");
    return (names as string[]).map((name) => {
      const row = db.prepare("SELECT id FROM groups WHERE name = ?").get(name) as { id: string } | undefined;
      if (!row) throw invalid(`Group "${name}" does not exist.`);
      return row.id;
    });
  }

  function listGroups(): Group[] {
    return db
      .prepare("SELECT g.id, g.name, COUNT(pg.person_id) AS people FROM groups g LEFT JOIN person_groups pg ON pg.group_id = g.id GROUP BY g.id ORDER BY g.name")
      .all() as unknown as Group[];
  }

  function createGroup(body: { name?: unknown }): Group {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) throw invalid("name is required, at most 100 characters.");
    if (db.prepare("SELECT 1 FROM groups WHERE name = ?").get(name)) throw new VpnError(409, "conflict", `A group named "${name}" exists.`);
    const id = randomUUID();
    db.prepare("INSERT INTO groups (id, name) VALUES (?, ?)").run(id, name);
    return { id, name, people: 0 };
  }

  function deleteGroup(id: string) {
    if (db.prepare("DELETE FROM groups WHERE id = ?").run(id).changes === 0) throw notFound("Group");
  }

  // ---- people -------------------------------------------------------------

  function person(id: string): Person {
    const row = db.prepare("SELECT id, name, email, status, created_at FROM people WHERE id = ?").get(id) as
      | { id: string; name: string; email: string; status: Person["status"]; created_at: string }
      | undefined;
    if (!row) throw notFound("Person");
    const groups = (db.prepare("SELECT g.name FROM person_groups pg JOIN groups g ON g.id = pg.group_id WHERE pg.person_id = ? ORDER BY g.name").all(id) as Array<{ name: string }>).map((g) => g.name);
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE person_id = ? AND revoked_at IS NULL").get(id) as { n: number };
    return { id: row.id, name: row.name, email: row.email, status: row.status, groups, devices: n, createdAt: row.created_at };
  }

  const listPeople = (): Person[] => (db.prepare("SELECT id FROM people ORDER BY name").all() as Array<{ id: string }>).map((r) => person(r.id));

  function setGroups(personId: string, names: unknown) {
    const ids = groupIds(names);
    db.prepare("DELETE FROM person_groups WHERE person_id = ?").run(personId);
    for (const g of ids) db.prepare("INSERT INTO person_groups (person_id, group_id) VALUES (?, ?)").run(personId, g);
  }

  function createPerson(body: { name?: unknown; email?: unknown; groups?: unknown }): Person {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!name || name.length > 200) throw invalid("name is required, at most 200 characters.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("email must be an email address.");
    if (db.prepare("SELECT 1 FROM people WHERE email = ?").get(email)) throw new VpnError(409, "conflict", `${email} is already a person.`);
    const id = randomUUID();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO people (id, name, email, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(id, name, email, now());
      setGroups(id, body.groups ?? []);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return person(id);
  }

  function updatePerson(id: string, body: { name?: unknown; status?: unknown; groups?: unknown }): Person {
    person(id);
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw invalid("name must be a non-empty string.");
      db.prepare("UPDATE people SET name = ? WHERE id = ?").run(body.name.trim(), id);
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "suspended") throw invalid('status must be "active" or "suspended".');
      db.prepare("UPDATE people SET status = ? WHERE id = ?").run(body.status, id);
    }
    if (body.groups !== undefined) setGroups(id, body.groups);
    return person(id);
  }

  function deletePerson(id: string) {
    person(id);
    for (const d of db.prepare("SELECT id FROM devices WHERE person_id = ? AND revoked_at IS NULL").all(id) as Array<{ id: string }>) revokeDevice(d.id);
    db.prepare("DELETE FROM people WHERE id = ?").run(id);
  }

  // ---- IP groups ----------------------------------------------------------

  function ipGroup(id: string): IpGroup {
    const row = db.prepare("SELECT id, name, full_tunnel FROM ip_groups WHERE id = ?").get(id) as { id: string; name: string; full_tunnel: number } | undefined;
    if (!row) throw notFound("IP group");
    const networks = db.prepare("SELECT cidr, ports, note FROM ip_group_networks WHERE ip_group_id = ? ORDER BY rowid").all(id) as unknown as IpNetwork[];
    const allowedGroups = (db.prepare("SELECT g.name FROM ip_group_access a JOIN groups g ON g.id = a.group_id WHERE a.ip_group_id = ? ORDER BY g.name").all(id) as Array<{ name: string }>).map((g) => g.name);
    return { id: row.id, name: row.name, fullTunnel: row.full_tunnel === 1, networks, allowedGroups };
  }

  const listIpGroups = (): IpGroup[] => (db.prepare("SELECT id FROM ip_groups ORDER BY name").all() as Array<{ id: string }>).map((r) => ipGroup(r.id));

  function writeIpGroup(id: string, body: { networks?: unknown; allowedGroups?: unknown }) {
    if (body.networks !== undefined) {
      if (!Array.isArray(body.networks)) throw invalid("networks must be a list of { cidr, ports?, note? }.");
      const rows = body.networks.map((n: { cidr?: unknown; ports?: unknown; note?: unknown }) => {
        const cidr = typeof n?.cidr === "string" ? parseCidr(n.cidr.trim()) : undefined;
        if (!cidr) throw invalid(`"${String(n?.cidr)}" is not an IPv4 network such as 172.16.20.0/24.`);
        const ports = typeof n.ports === "string" ? n.ports.trim() || "any" : "any";
        if (!parsePorts(ports)) throw invalid(`"${ports}" is not a port list such as tcp/5432, 6432 or any.`);
        return { cidr: formatCidr(cidr), ports, note: typeof n.note === "string" ? n.note.slice(0, 200) : "" };
      });
      db.prepare("DELETE FROM ip_group_networks WHERE ip_group_id = ?").run(id);
      for (const r of rows) db.prepare("INSERT INTO ip_group_networks (ip_group_id, cidr, ports, note) VALUES (?, ?, ?, ?)").run(id, r.cidr, r.ports, r.note);
    }
    if (body.allowedGroups !== undefined) {
      const ids = groupIds(body.allowedGroups);
      db.prepare("DELETE FROM ip_group_access WHERE ip_group_id = ?").run(id);
      for (const g of ids) db.prepare("INSERT INTO ip_group_access (ip_group_id, group_id) VALUES (?, ?)").run(id, g);
    }
  }

  function createIpGroup(body: { name?: unknown; fullTunnel?: unknown; networks?: unknown; allowedGroups?: unknown }): IpGroup {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) throw invalid("name is required, at most 100 characters.");
    if (db.prepare("SELECT 1 FROM ip_groups WHERE name = ?").get(name)) throw new VpnError(409, "conflict", `An IP group named "${name}" exists.`);
    const id = randomUUID();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO ip_groups (id, name, full_tunnel) VALUES (?, ?, ?)").run(id, name, body.fullTunnel === true ? 1 : 0);
      writeIpGroup(id, { networks: body.networks ?? [], allowedGroups: body.allowedGroups ?? [] });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return ipGroup(id);
  }

  function updateIpGroup(id: string, body: { fullTunnel?: unknown; networks?: unknown; allowedGroups?: unknown }): IpGroup {
    ipGroup(id);
    if (body.fullTunnel !== undefined) {
      if (typeof body.fullTunnel !== "boolean") throw invalid("fullTunnel must be true or false.");
      db.prepare("UPDATE ip_groups SET full_tunnel = ? WHERE id = ?").run(body.fullTunnel ? 1 : 0, id);
    }
    writeIpGroup(id, body);
    return ipGroup(id);
  }

  function deleteIpGroup(id: string) {
    if (db.prepare("DELETE FROM ip_groups WHERE id = ?").run(id).changes === 0) throw notFound("IP group");
  }

  // ---- devices ------------------------------------------------------------

  const toDevice = (r: { id: string; person_id: string; name: string; vpn_ip: string; not_after: string; created_at: string; revoked_at: string | null }): Device => ({
    id: r.id,
    personId: r.person_id,
    name: r.name,
    vpnIp: r.vpn_ip,
    notAfter: r.not_after,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  });

  function listDevices(personId: string): Device[] {
    person(personId);
    return (db.prepare("SELECT * FROM devices WHERE person_id = ? ORDER BY created_at").all(personId) as Parameters<typeof toDevice>[0][]).map(toDevice);
  }

  function allocateIp(): string {
    const used = new Set((db.prepare("SELECT vpn_ip FROM devices WHERE revoked_at IS NULL").all() as Array<{ vpn_ip: string }>).map((r) => parseIp(r.vpn_ip)));
    const { first, last } = clientAddresses(network as Cidr);
    for (let ip = first; ip <= last; ip++) if (!used.has(ip)) return formatIp(ip);
    throw new VpnError(409, "conflict", `No free address left in ${opts.network}. Revoke unused devices or use a larger VPN_NETWORK.`);
  }

  /** Issues a certificate for a new device and returns its client config. The private key is not kept. */
  async function createDevice(personId: string, body: { name?: unknown }): Promise<{ device: Device; ovpn: string }> {
    const p = person(personId);
    if (p.status !== "active") throw new VpnError(409, "conflict", `${p.name} is suspended; activate them before adding a device.`);
    if (!opts.publicHost) throw new VpnError(409, "conflict", "Set VPN_PUBLIC_HOST to the address clients connect to before adding devices.");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) throw invalid("name is required, at most 100 characters, for example \"Work laptop\".");
    const id = randomUUID();
    const cert = await issue(ca(), "client", id);
    const ip = allocateIp();
    db.prepare("INSERT INTO devices (id, person_id, name, serial, vpn_ip, cert, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, personId, name, cert.serial, ip, cert.cert, cert.notAfter, now());
    const device = toDevice(db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Parameters<typeof toDevice>[0]);
    return { device, ovpn: clientConfig(p.name, name, cert.cert, cert.key) };
  }

  function revokeDevice(id: string): Device {
    const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as (Parameters<typeof toDevice>[0] & { serial: string }) | undefined;
    if (!row) throw notFound("Device");
    if (!row.revoked_at) {
      const at = now();
      db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(at, id);
      db.prepare("INSERT OR IGNORE INTO revocations (serial, revoked_at) VALUES (?, ?)").run(row.serial, at);
    }
    return toDevice(db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Parameters<typeof toDevice>[0]);
  }

  // ---- what servers run ---------------------------------------------------

  function remotes(): Array<{ proto: "udp" | "tcp"; port: number }> {
    const listens = (db.prepare("SELECT DISTINCT listen FROM servers").all() as Array<{ listen: string | null }>).map((r) => r.listen ?? "udp/1194");
    const unique = [...new Set(listens.length ? listens : ["udp/1194"])].sort((a, b) => (a.startsWith("udp") ? -1 : 1) - (b.startsWith("udp") ? -1 : 1));
    return unique.map((l) => {
      const [proto, port] = l.split("/");
      return { proto: proto as "udp" | "tcp", port: Number(port) };
    });
  }

  function clientConfig(personName: string, deviceName: string, cert: string, key: string): string {
    const lines = [
      `# OpenAsy VPN: ${personName}, ${deviceName}`,
      "# Keep this file private: it contains the device's private key.",
      "client",
      "dev tun",
      "nobind",
      // UDP first; clients fall back to the next remote, for example TCP 443 on networks that block UDP.
      ...remotes().map((r) => `remote ${opts.publicHost} ${r.port} ${r.proto === "tcp" ? "tcp-client" : "udp"}`),
      "remote-cert-tls server",
      "persist-key",
      "persist-tun",
      "data-ciphers AES-256-GCM:CHACHA20-POLY1305",
      "tls-version-min 1.2",
      "verb 3",
      `<ca>\n${ca().cert.trim()}\n</ca>`,
      `<cert>\n${cert.trim()}\n</cert>`,
      `<key>\n${key.trim()}\n</key>`,
      `<tls-crypt>\n${get("tls_crypt")!.trim()}\n</tls-crypt>`,
      "",
    ];
    return lines.join("\n");
  }

  function clientRules(): ServerConfig["clients"] {
    const rows = db
      .prepare(
        `SELECT d.id AS cn, d.vpn_ip AS ip, d.person_id FROM devices d JOIN people p ON p.id = d.person_id
         WHERE d.revoked_at IS NULL AND p.status = 'active' AND d.not_after > ? ORDER BY d.vpn_ip`,
      )
      .all(now()) as Array<{ cn: string; ip: string; person_id: string }>;
    return rows.map((r) => {
      const groups = db
        .prepare(
          `SELECT DISTINCT ig.id, ig.full_tunnel FROM ip_groups ig
           JOIN ip_group_access a ON a.ip_group_id = ig.id
           JOIN person_groups pg ON pg.group_id = a.group_id
           WHERE pg.person_id = ?`,
        )
        .all(r.person_id) as Array<{ id: string; full_tunnel: number }>;
      const routes = new Set<string>();
      let fullTunnel = false;
      for (const g of groups) {
        if (g.full_tunnel) fullTunnel = true;
        for (const n of db.prepare("SELECT cidr FROM ip_group_networks WHERE ip_group_id = ?").all(g.id) as Array<{ cidr: string }>) {
          if (n.cidr === "0.0.0.0/0") fullTunnel = true;
          else routes.add(n.cidr);
        }
      }
      return { cn: r.cn, ip: r.ip, routes: [...routes].sort(), fullTunnel };
    });
  }

  /** The desired state of one server. Issues its certificate on first use. */
  async function serverConfig(serverId: string): Promise<ServerConfig> {
    let row = db.prepare("SELECT cert, key FROM server_certs WHERE server_id = ?").get(serverId) as { cert: string; key: string } | undefined;
    if (!row) {
      const cert = await issue(ca(), "server", serverId);
      db.prepare("INSERT INTO server_certs (server_id, serial, cert, key, not_after) VALUES (?, ?, ?, ?, ?)").run(serverId, cert.serial, cert.cert, cert.key, cert.notAfter);
      row = cert;
    }
    const revoked = db.prepare("SELECT serial, revoked_at AS at FROM revocations ORDER BY serial").all() as Array<{ serial: string; at: string }>;
    // A CRL is signed with a timestamp, so it is cached to keep `version` stable between pulls. It is signed again
    // when revocations change, and every week: it is valid for 30 days, and OpenVPN refuses every client once it expires.
    const crlKey = createHash("sha256").update(JSON.stringify(revoked)).digest("hex");
    const cached = get("crl");
    const [cachedKey, signedAt, cachedPem] = cached ? (JSON.parse(cached) as [string, number, string]) : [];
    let crlPem = cachedPem;
    if (!crlPem || cachedKey !== crlKey || Date.now() - signedAt! > CRL_REFRESH) {
      crlPem = await crl(ca(), revoked);
      putSetting.run("crl", JSON.stringify([crlKey, Date.now(), crlPem]));
    }
    const body = { network: opts.network, ca: ca().cert, cert: row.cert, key: row.key, crl: crlPem, tlsCrypt: get("tls_crypt")!, clients: clientRules() };
    const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
    return { version, ...body };
  }

  return {
    init,
    listGroups,
    createGroup,
    deleteGroup,
    listPeople,
    person,
    createPerson,
    updatePerson,
    deletePerson,
    listIpGroups,
    ipGroup,
    createIpGroup,
    updateIpGroup,
    deleteIpGroup,
    listDevices,
    createDevice,
    revokeDevice,
    serverConfig,
  };
}

export type Vpn = ReturnType<typeof createVpn>;
