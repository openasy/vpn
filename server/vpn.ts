// The VPN's data: people, groups, IP groups, devices and what each vpn-server must run.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { clientAddresses, formatCidr, formatIp, parseCidr, parseIp, parsePorts, type Cidr } from "./net.ts";
import type { Keyring } from "./kek.ts";
import { crl, createCa, issue, tlsCryptKey, type Ca } from "./pki.ts";

type VpnErrorCode = "invalid-body" | "not-found" | "conflict" | "invalid-token";

export class VpnError extends Error {
  readonly status: number;
  readonly code: VpnErrorCode;
  constructor(status: number, code: VpnErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (m: string) => new VpnError(422, "invalid-body", m);
const notFound = (what: string) => new VpnError(404, "not-found", `${what} does not exist.`);
const now = () => new Date().toISOString();
const CRL_REFRESH = 7 * 864e5;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** An enrolment token works this long, once. */
const ENROLL_TTL_MS = 7 * 864e5;
/** A server that has not reported for this long is offline; it reports every 15 seconds. */
export const SERVER_OFFLINE_MS = 60_000;
export const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A host name or IPv4 address clients connect to. */
const ADDRESS = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

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
  clients: Array<{ cn: string; ip: string; routes: string[]; fullTunnel: boolean; allow: Allow[] }>;
}

/** One firewall rule: traffic from a device to `cidr`, on these ports (empty: every port). */
export interface Allow {
  cidr: string;
  proto: "tcp" | "udp" | "any";
  ports: number[];
}

export interface Session {
  serverId: string;
  deviceId: string;
  deviceName: string | null;
  personId: string | null;
  personName: string | null;
  realAddress: string;
  vpnIp: string;
  bytesIn: number;
  bytesOut: number;
  connectedAt: string;
}

export interface Server {
  id: string;
  /** Host name or IP clients connect to; null uses VPN_PUBLIC_HOST. */
  address: string | null;
  status: "waiting-to-enrol" | "online" | "offline" | "version-mismatch";
  /** Reports with VPN_SERVER_TOKEN instead of its own secret; enrol it again to move it off. */
  legacy: boolean;
  version: string | null;
  /** "udp/1194", "tcp/443"; null when the server's config file decides or it has not reported. */
  listen: string | null;
  openvpnRunning: boolean;
  configVersion: string | null;
  lastSeen: string | null;
  createdAt: string;
}

export interface ServerReport {
  version: string;
  listen: string | null;
  openvpnRunning: boolean;
  configVersion: string | null;
}

type ServerRow = {
  id: string;
  address: string | null;
  legacy: number;
  enroll_token_hash: string | null;
  enroll_expires_at: string | null;
  secret_hash: string | null;
  version: string | null;
  listen: string | null;
  openvpn_running: number;
  config_version: string | null;
  last_seen: string | null;
  created_at: string;
};

export interface ReportedSession {
  cn: string;
  realAddress: string;
  vpnIp: string;
  bytesIn: number;
  bytesOut: number;
  connectedAt: string;
}

export interface VpnOptions {
  /** Address pool for clients, for example 10.8.0.0/24. */
  network: string;
  /** Host name or IP clients connect to, for servers that have no address of their own. */
  publicHost?: string;
  /** This release; a server of another version is shown as such (ADR 0019). */
  version?: string;
  /** Seals the CA key, the tls-crypt key and server keys in the database (ADR 0021). */
  keyring: Keyring;
}

export function createVpn(db: DatabaseSync, opts: VpnOptions) {
  const network = parseCidr(opts.network);
  if (!network || network.prefix > 29) throw new Error(`VPN_NETWORK must be an IPv4 network of /29 or larger, not "${opts.network}"`);

  const setting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const putSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const get = (key: string) => (setting.get(key) as { value: string } | undefined)?.value;

  // Private keys are sealed (ADR 0021): a copy of the database or its backup does not hold them in the clear.
  // Values written before 0.5.0 are PEM, which never starts with "v1."; init() seals them.
  const isSealed = (v: string) => v.startsWith("v1.");
  const open = (v: string) => (isSealed(v) ? opts.keyring.open(v).toString("utf8") : v);
  const secret = (key: string) => open(get(key)!);

  /**
   * Creates the CA and tls-crypt key on first start, and seals keys stored in the clear by earlier versions.
   * Returns how many it sealed. Fails when the key-encryption key is not the one the data was sealed with.
   */
  async function init(): Promise<{ sealed: number }> {
    let sealed = 0;
    if (!get("ca_cert")) {
      const ca = await createCa();
      putSetting.run("ca_cert", ca.cert);
      putSetting.run("ca_key", opts.keyring.seal(ca.key));
    }
    if (!get("tls_crypt")) putSetting.run("tls_crypt", opts.keyring.seal(tlsCryptKey()));
    try {
      secret("ca_key");
    } catch {
      throw new Error("the key-encryption key does not open the CA key: mount the key this data was sealed with");
    }
    db.exec("BEGIN");
    try {
      for (const key of ["ca_key", "tls_crypt"]) {
        const v = get(key)!;
        if (!isSealed(v)) (putSetting.run(key, opts.keyring.seal(v)), sealed++);
      }
      for (const r of db.prepare("SELECT server_id, key FROM server_certs").all() as Array<{ server_id: string; key: string }>) {
        if (!isSealed(r.key)) (db.prepare("UPDATE server_certs SET key = ? WHERE server_id = ?").run(opts.keyring.seal(r.key), r.server_id), sealed++);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { sealed };
  }

  const ca = (): Ca => ({ cert: get("ca_cert")!, key: secret("ca_key") });

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
      .prepare(
        "SELECT g.id, g.name, COUNT(pg.person_id) AS people FROM groups g LEFT JOIN person_groups pg ON pg.group_id = g.id GROUP BY g.id ORDER BY g.name",
      )
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
      { id: string; name: string; email: string; status: Person["status"]; created_at: string } | undefined;
    if (!row) throw notFound("Person");
    const groups = (
      db.prepare("SELECT g.name FROM person_groups pg JOIN groups g ON g.id = pg.group_id WHERE pg.person_id = ? ORDER BY g.name").all(id) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
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
    const allowedGroups = (
      db.prepare("SELECT g.name FROM ip_group_access a JOIN groups g ON g.id = a.group_id WHERE a.ip_group_id = ? ORDER BY g.name").all(id) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
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

  const toDevice = (r: {
    id: string;
    person_id: string;
    name: string;
    vpn_ip: string;
    not_after: string;
    created_at: string;
    revoked_at: string | null;
  }): Device => ({
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
    if (!remotes().length)
      throw new VpnError(
        409,
        "conflict",
        "No server has an address clients can connect to. Give a server its address under Servers, or set VPN_PUBLIC_HOST, before adding devices.",
      );
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) throw invalid('name is required, at most 100 characters, for example "Work laptop".');
    const id = randomUUID();
    const cert = await issue(ca(), "client", id);
    const ip = allocateIp();
    db.prepare("INSERT INTO devices (id, person_id, name, serial, vpn_ip, cert, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      personId,
      name,
      cert.serial,
      ip,
      cert.cert,
      cert.notAfter,
      now(),
    );
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

  /**
   * Where clients connect: one line per server, at its own address or VPN_PUBLIC_HOST. UDP first, then TCP for
   * networks that block UDP; servers by id within each. A server that has never reported is left out: its port is
   * not known yet.
   */
  function remotes(): Array<{ host: string; proto: "udp" | "tcp"; port: number }> {
    const rows = db.prepare("SELECT id, address, listen FROM servers WHERE last_seen IS NOT NULL ORDER BY id").all() as Array<{
      id: string;
      address: string | null;
      listen: string | null;
    }>;
    const found = new Map<string, { host: string; proto: "udp" | "tcp"; port: number }>();
    for (const r of rows.length ? rows : [{ id: "", address: null, listen: null }]) {
      const host = r.address ?? opts.publicHost;
      if (!host) continue;
      const [proto, port] = (r.listen ?? "udp/1194").split("/");
      const remote = { host, proto: proto as "udp" | "tcp", port: Number(port) };
      found.set(`${host} ${port} ${proto}`, remote);
    }
    return [...found.values()].sort((a, b) => (a.proto === b.proto ? 0 : a.proto === "udp" ? -1 : 1));
  }

  function clientConfig(personName: string, deviceName: string, cert: string, key: string): string {
    const lines = [
      `# OpenAsy VPN: ${personName}, ${deviceName}`,
      "# Keep this file private: it contains the device's private key.",
      "client",
      "dev tun",
      "nobind",
      // Clients try each remote in turn: another server when one is down, TCP 443 on networks that block UDP.
      ...remotes().map((r) => `remote ${r.host} ${r.port} ${r.proto === "tcp" ? "tcp-client" : "udp"}`),
      "remote-cert-tls server",
      "persist-key",
      "persist-tun",
      "data-ciphers AES-256-GCM:CHACHA20-POLY1305",
      "tls-version-min 1.2",
      "verb 3",
      `<ca>\n${ca().cert.trim()}\n</ca>`,
      `<cert>\n${cert.trim()}\n</cert>`,
      `<key>\n${key.trim()}\n</key>`,
      `<tls-crypt>\n${secret("tls_crypt").trim()}\n</tls-crypt>`,
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
      const allow = new Map<string, Allow>();
      let fullTunnel = false;
      for (const g of groups) {
        if (g.full_tunnel) fullTunnel = true;
        for (const n of db.prepare("SELECT cidr, ports FROM ip_group_networks WHERE ip_group_id = ?").all(g.id) as Array<{ cidr: string; ports: string }>) {
          if (n.cidr === "0.0.0.0/0") fullTunnel = true;
          else routes.add(n.cidr);
          for (const rule of parsePorts(n.ports)!) {
            const a: Allow = { cidr: n.cidr, proto: rule.proto, ports: rule.ports };
            allow.set(JSON.stringify(a), a);
          }
        }
      }
      const rules = [...allow.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { cn: r.cn, ip: r.ip, routes: [...routes].sort(), fullTunnel, allow: rules };
    });
  }

  /** The desired state of one server. Issues its certificate on first use. */
  async function serverConfig(serverId: string): Promise<ServerConfig> {
    let row = db.prepare("SELECT cert, key FROM server_certs WHERE server_id = ?").get(serverId) as { cert: string; key: string } | undefined;
    if (!row) {
      const cert = await issue(ca(), "server", serverId);
      db.prepare("INSERT INTO server_certs (server_id, serial, cert, key, not_after) VALUES (?, ?, ?, ?, ?)").run(
        serverId,
        cert.serial,
        cert.cert,
        opts.keyring.seal(cert.key),
        cert.notAfter,
      );
      row = cert;
    } else {
      row = { cert: row.cert, key: open(row.key) };
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
    const body = { network: opts.network, ca: ca().cert, cert: row.cert, key: row.key, crl: crlPem, tlsCrypt: secret("tls_crypt"), clients: clientRules() };
    const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
    return { version, ...body };
  }

  // ---- servers ------------------------------------------------------------

  const serverRow = (id: string) => db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined;
  const requireServer = (id: string) => {
    const s = serverRow(id);
    if (!s) throw notFound("Server");
    return s;
  };

  function toServer(s: ServerRow): Server {
    const online = !!s.last_seen && Date.now() - Date.parse(s.last_seen) <= SERVER_OFFLINE_MS;
    const status: Server["status"] =
      !s.secret_hash && !s.legacy ? "waiting-to-enrol" : !online ? "offline" : opts.version && s.version !== opts.version ? "version-mismatch" : "online";
    return {
      id: s.id,
      address: s.address,
      status,
      legacy: s.legacy === 1,
      version: s.version,
      listen: s.listen,
      openvpnRunning: s.openvpn_running === 1,
      configVersion: s.config_version,
      lastSeen: s.last_seen,
      createdAt: s.created_at,
    };
  }

  const listServers = (): Server[] => (db.prepare("SELECT * FROM servers ORDER BY id").all() as ServerRow[]).map(toServer);
  const server = (id: string): Server => toServer(requireServer(id));

  function address(value: unknown): string | null {
    if (value === null || value === "") return null;
    const a = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!ADDRESS.test(a)) throw invalid("address must be a host name such as fra.vpn.example.com or an IPv4 address.");
    return a;
  }

  function newEnrollToken(id: string) {
    const token = `ove_${randomBytes(24).toString("base64url")}`;
    const expires = new Date(Date.now() + ENROLL_TTL_MS).toISOString();
    db.prepare("UPDATE servers SET enroll_token_hash = ?, enroll_expires_at = ? WHERE id = ?").run(sha256(token), expires, id);
    return { enrollToken: token, enrollExpiresAt: expires };
  }

  /** Revokes a server's certificate and forgets it; the server gets a new one when it next pulls its config. */
  function dropServerCert(id: string) {
    const cert = db.prepare("SELECT serial FROM server_certs WHERE server_id = ?").get(id) as { serial: string } | undefined;
    if (!cert) return;
    db.prepare("INSERT OR IGNORE INTO revocations (serial, revoked_at) VALUES (?, ?)").run(cert.serial, now());
    db.prepare("DELETE FROM server_certs WHERE server_id = ?").run(id);
  }

  /** A new server and its one-time enrolment token, shown once. */
  function createServer(body: { id?: unknown; address?: unknown }) {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!SERVER_ID.test(id)) throw invalid("id is lowercase letters, digits and dashes, up to 63, for example fra-1.");
    const addr = address(body.address ?? null);
    if (serverRow(id)) throw new VpnError(409, "conflict", `A server named ${id} exists.`);
    db.prepare("INSERT INTO servers (id, address, created_at) VALUES (?, ?, ?)").run(id, addr, now());
    // A certificate left by an earlier server of this name is not handed to the new one.
    dropServerCert(id);
    const token = newEnrollToken(id);
    return { server: server(id), ...token };
  }

  function updateServer(id: string, body: { address?: unknown }): Server {
    requireServer(id);
    if (body.address !== undefined) db.prepare("UPDATE servers SET address = ? WHERE id = ?").run(address(body.address), id);
    return server(id);
  }

  /**
   * A new enrolment token, for a server that lost its volume or still uses VPN_SERVER_TOKEN. Its old secret stops
   * working, and it gets a new certificate.
   */
  function reEnrollServer(id: string) {
    requireServer(id);
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE servers SET secret_hash = NULL, legacy = 0 WHERE id = ?").run(id);
      dropServerCert(id);
      const token = newEnrollToken(id);
      db.exec("COMMIT");
      return { server: server(id), ...token };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function deleteServer(id: string) {
    requireServer(id);
    db.exec("BEGIN");
    try {
      dropServerCert(id);
      db.prepare("DELETE FROM sessions WHERE server_id = ?").run(id);
      db.prepare("DELETE FROM pending_disconnects WHERE server_id = ?").run(id);
      db.prepare("DELETE FROM servers WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Trades a one-time enrolment token for the server's own secret. Only its hash is kept. */
  function enrollServer(body: { token?: unknown }) {
    const token = typeof body.token === "string" ? body.token : "";
    const s = token ? (db.prepare("SELECT * FROM servers WHERE enroll_token_hash = ?").get(sha256(token)) as ServerRow | undefined) : undefined;
    if (!s || !s.enroll_expires_at || s.enroll_expires_at <= now()) {
      throw new VpnError(401, "invalid-token", "The enrolment token is unknown, used or expired. Create a new one under Servers.");
    }
    const secret = `ovs_${randomBytes(32).toString("base64url")}`;
    db.prepare("UPDATE servers SET enroll_token_hash = NULL, enroll_expires_at = NULL, secret_hash = ?, legacy = 0 WHERE id = ?").run(sha256(secret), s.id);
    return { serverId: s.id, secret };
  }

  /** The server a secret belongs to, if any. */
  const serverBySecret = (secret: string) => (db.prepare("SELECT id FROM servers WHERE secret_hash = ?").get(sha256(secret)) as { id: string } | undefined)?.id;

  /** VPN_SERVER_TOKEN may speak for a server only while it is legacy, or new: enrolled servers use their own secret. */
  function legacyAllowed(id: string): boolean {
    const s = serverRow(id);
    return !s || s.legacy === 1;
  }

  /** Records a heartbeat. A legacy server reporting for the first time is added. */
  function recordHeartbeat(id: string, r: ServerReport, legacy: boolean) {
    const at = now();
    if (legacy) db.prepare("INSERT OR IGNORE INTO servers (id, legacy, created_at) VALUES (?, 1, ?)").run(id, at);
    db.prepare("UPDATE servers SET version = ?, listen = ?, openvpn_running = ?, config_version = ?, last_seen = ? WHERE id = ?").run(
      r.version,
      r.listen,
      r.openvpnRunning ? 1 : 0,
      r.configVersion,
      at,
      id,
    );
  }

  // ---- sessions -----------------------------------------------------------

  /** Replaces what a server reported as connected. */
  function recordSessions(serverId: string, sessions: ReportedSession[]) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM sessions WHERE server_id = ?").run(serverId);
      const insert = db.prepare(
        "INSERT OR REPLACE INTO sessions (server_id, cn, real_address, vpn_ip, bytes_in, bytes_out, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const x of sessions) insert.run(serverId, x.cn, x.realAddress, x.vpnIp, x.bytesIn, x.bytesOut, x.connectedAt);
      // A disconnect for a session that is gone is done.
      db.prepare("DELETE FROM pending_disconnects WHERE server_id = ? AND cn NOT IN (SELECT cn FROM sessions WHERE server_id = ?)").run(serverId, serverId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Live sessions from servers that reported within `freshMs`; older reports may be stale. */
  function listSessions(freshMs: number): Session[] {
    const since = new Date(Date.now() - freshMs).toISOString();
    return (
      db
        .prepare(
          `SELECT s.server_id, s.cn, d.name AS device_name, p.id AS person_id, p.name AS person_name, s.real_address, s.vpn_ip, s.bytes_in, s.bytes_out, s.connected_at
           FROM sessions s JOIN servers v ON v.id = s.server_id
           LEFT JOIN devices d ON d.id = s.cn LEFT JOIN people p ON p.id = d.person_id
           WHERE v.last_seen >= ? ORDER BY s.connected_at`,
        )
        .all(since) as Array<Record<string, string | number | null>>
    ).map((r) => ({
      serverId: r.server_id as string,
      deviceId: r.cn as string,
      deviceName: r.device_name as string | null,
      personId: r.person_id as string | null,
      personName: r.person_name as string | null,
      realAddress: r.real_address as string,
      vpnIp: r.vpn_ip as string,
      bytesIn: r.bytes_in as number,
      bytesOut: r.bytes_out as number,
      connectedAt: r.connected_at as string,
    }));
  }

  /** Asks the server to end a session at its next heartbeat. The device may connect again if it is still allowed. */
  function requestDisconnect(serverId: string, deviceId: string) {
    if (!db.prepare("SELECT 1 FROM sessions WHERE server_id = ? AND cn = ?").get(serverId, deviceId)) throw notFound("Session");
    db.prepare("INSERT OR IGNORE INTO pending_disconnects (server_id, cn) VALUES (?, ?)").run(serverId, deviceId);
  }

  const pendingDisconnects = (serverId: string) =>
    (db.prepare("SELECT cn FROM pending_disconnects WHERE server_id = ? ORDER BY cn").all(serverId) as Array<{ cn: string }>).map((r) => r.cn);

  return {
    init,
    listServers,
    server,
    createServer,
    updateServer,
    reEnrollServer,
    deleteServer,
    enrollServer,
    serverBySecret,
    legacyAllowed,
    recordHeartbeat,
    recordSessions,
    listSessions,
    requestDisconnect,
    pendingDisconnects,
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
