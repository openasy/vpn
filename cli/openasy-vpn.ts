#!/usr/bin/env node
// The command line tool of OpenAsy VPN (ADR 0014): the same public API the UI uses, with an API token.
// One file with no dependencies, so it runs anywhere Node 26 does: `node openasy-vpn.ts people`.
import { writeFileSync } from "node:fs";

const HELP = `openasy-vpn: manage OpenAsy VPN from the command line.

Usage: openasy-vpn <command> [arguments] [--json]

  people                                    List people
  people add <name> <email> [--group <g>]... Add a person
  people show <person>                      One person; <person> is an email address or an id
  people groups <person> [<group>]...       Set their groups; none removes them from every group
  people suspend <person>                   Disconnect their devices and keep them out
  people activate <person>                  Let their devices connect again
  people remove <person>                    Revoke their devices and remove them

  devices <person>                          List their devices
  devices add <person> <name> [--out <file>]
                                            Issue a device and write its .ovpn file (--out - prints it).
                                            The file holds the device's private key and is given once.
  devices revoke <device id>                Revoke a device for good

  groups                                    List groups
  groups add <name>                         Add a group
  groups remove <group>                     Remove a group

  ip-groups                                 List IP groups
  ip-groups add <name> --network <cidr>[=<ports>]... [--allow <group>]... [--full-tunnel]
                                            For example --network 172.16.20.0/24=tcp/5432,6432
  ip-groups remove <ip group>               Remove an IP group

  sessions                                  Devices connected now
  sessions end <server> <device id>         End a session; the device may connect again if allowed

  servers                                   vpn-server instances and their last heartbeat

Environment:
  VPN_URL        Address of vpn, default http://localhost:8080
  VPN_API_TOKEN  An API token from Settings, API tokens. Its role decides what you may do.

--json prints the API's answer as it is, for scripts.
`;

export interface Io {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof fetch;
  writeFile?: (path: string, data: string) => void;
}

class CliError extends Error {}

interface Person {
  id: string;
  name: string;
  email: string;
  status: string;
  groups: string[];
  devices: number;
}
interface Device {
  id: string;
  name: string;
  vpnIp: string;
  notAfter: string;
  revokedAt: string | null;
}
interface Group {
  id: string;
  name: string;
  people: number;
}
interface IpGroup {
  id: string;
  name: string;
  fullTunnel: boolean;
  networks: Array<{ cidr: string; ports: string; note: string }>;
  allowedGroups: string[];
}
interface Session {
  serverId: string;
  deviceId: string;
  deviceName: string | null;
  personName: string | null;
  realAddress: string;
  vpnIp: string;
  bytesIn: number;
  bytesOut: number;
  connectedAt: string;
}
interface Server {
  id: string;
  version: string;
  listen: string | null;
  openvpnRunning: boolean;
  configVersion: string | null;
  lastSeen: string;
}

/** Splits arguments into positional ones and flags; repeated flags collect into a list. */
function parse(argv: string[]) {
  const args: string[] = [];
  const flags = new Map<string, string[]>();
  const valueless = new Set(["json", "full-tunnel", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") flags.set("help", ["true"]);
    else if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (valueless.has(name)) flags.set(name, ["true"]);
      else {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new CliError(`--${name} needs a value.`);
        flags.set(name, [...(flags.get(name) ?? []), value]);
      }
    } else args.push(a);
  }
  return { args, flags, has: (f: string) => flags.has(f), all: (f: string) => flags.get(f) ?? [], one: (f: string) => flags.get(f)?.at(-1) };
}

/** Columns padded to the widest value; the last one is not padded. */
function table(head: string[], rows: string[][]): string {
  if (!rows.length) return "";
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n") + "\n";
}

const bytes = (n: number) => {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const day = (iso: string) => iso.slice(0, 10);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "device";

export async function run(argv: string[], io: Io): Promise<number> {
  const f = io.fetch ?? fetch;
  let opts: ReturnType<typeof parse>;
  try {
    opts = parse(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n`);
    return 2;
  }
  const { args, has, all, one } = opts;
  if (!args.length || has("help") || args[0] === "help") {
    io.out(HELP);
    return args.length || has("help") ? 0 : 2;
  }
  const base = (io.env.VPN_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const token = io.env.VPN_API_TOKEN;

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!token) throw new CliError("Set VPN_API_TOKEN to an API token from Settings, API tokens.");
    let res: Response;
    try {
      res = await f(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new CliError(`Cannot reach ${base}: ${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message}. Set VPN_URL to the address of vpn.`);
    }
    if (!res.ok) {
      const p = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
      throw new CliError(p.detail ?? p.title ?? `${method} ${path}: ${res.status}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  const print = (data: unknown, text: string) => io.out(has("json") ? `${JSON.stringify(data, null, 2)}\n` : text);
  const need = (n: number, usage: string) => {
    if (args.length < n) throw new CliError(`Usage: openasy-vpn ${usage}`);
  };

  async function person(ref: string): Promise<Person> {
    const { people } = await api<{ people: Person[] }>("GET", "/api/v1/people");
    const found = people.find((p) => p.id === ref || p.email.toLowerCase() === ref.toLowerCase());
    if (!found) throw new CliError(`Nobody with the email or id "${ref}".`);
    return found;
  }
  async function byName<T extends { id: string; name: string }>(path: string, key: string, ref: string, what: string): Promise<T> {
    const list = (await api<Record<string, T[]>>("GET", path))[key]!;
    const found = list.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new CliError(`No ${what} named "${ref}".`);
    return found;
  }
  const personText = (p: Person) =>
    `${p.name} <${p.email}>\n  id       ${p.id}\n  status   ${p.status}\n  groups   ${p.groups.join(", ") || "none"}\n  devices  ${p.devices}\n`;

  try {
    const [cmd, sub] = args;
    switch (cmd) {
      case "people": {
        if (!sub) {
          const r = await api<{ people: Person[] }>("GET", "/api/v1/people");
          print(r, table(["NAME", "EMAIL", "STATUS", "DEVICES", "GROUPS"], r.people.map((p) => [p.name, p.email, p.status, String(p.devices), p.groups.join(", ")])) || "Nobody yet.\n");
        } else if (sub === "add") {
          need(4, "people add <name> <email> [--group <name>]...");
          const p = await api<Person>("POST", "/api/v1/people", { name: args[2], email: args[3], groups: all("group") });
          print(p, `Added ${p.name}. Next: openasy-vpn devices add ${p.email} "Laptop"\n`);
        } else if (sub === "show") {
          need(3, "people show <person>");
          const p = await person(args[2]!);
          print(p, personText(p));
        } else if (sub === "groups") {
          need(3, "people groups <person> [<group>]...");
          const p = await api<Person>("PATCH", `/api/v1/people/${(await person(args[2]!)).id}`, { groups: args.slice(3) });
          print(p, `${p.name} is in ${p.groups.join(", ") || "no group"}.\n`);
        } else if (sub === "suspend" || sub === "activate") {
          need(3, `people ${sub} <person>`);
          const p = await api<Person>("PATCH", `/api/v1/people/${(await person(args[2]!)).id}`, { status: sub === "suspend" ? "suspended" : "active" });
          print(p, sub === "suspend" ? `Suspended ${p.name}: their devices are disconnected within 15 seconds.\n` : `${p.name} is active again.\n`);
        } else if (sub === "remove") {
          need(3, "people remove <person>");
          const p = await person(args[2]!);
          await api("DELETE", `/api/v1/people/${p.id}`);
          print({ removed: p.id }, `Removed ${p.name}; their devices are revoked.\n`);
        } else throw new CliError(`Unknown command "people ${sub}". Run openasy-vpn help.`);
        return 0;
      }

      case "devices": {
        if (sub === "add") {
          need(4, "devices add <person> <name> [--out <file>]");
          const p = await person(args[2]!);
          const r = await api<{ device: Device; ovpn: string }>("POST", `/api/v1/people/${p.id}/devices`, { name: args[3] });
          const out = one("out") ?? `${slug(p.name)}-${slug(r.device.name)}.ovpn`;
          if (out === "-") {
            io.out(r.ovpn);
            return 0;
          }
          // Never over an existing file, and readable by its owner only: it holds the device's private key.
          try {
            (io.writeFile ?? ((path, data) => writeFileSync(path, data, { mode: 0o600, flag: "wx" })))(out, r.ovpn);
          } catch (err) {
            // The device exists now, so its file must not be lost: print it rather than fail.
            io.err(`Could not write ${out} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); here is the file instead. Revoke ${r.device.id} if it is not needed.\n`);
            io.out(r.ovpn);
            return 1;
          }
          print({ device: r.device, file: out }, `Wrote ${out} for ${p.name}, ${r.device.name} (${r.device.vpnIp}). It holds the device's private key and cannot be downloaded again: send it privately.\n`);
        } else if (sub === "revoke") {
          need(3, "devices revoke <device id>");
          const d = await api<Device>("DELETE", `/api/v1/devices/${encodeURIComponent(args[2]!)}`);
          print(d, `Revoked ${d.name}: it is disconnected within 15 seconds and cannot connect again.\n`);
        } else if (sub) {
          const p = await person(sub);
          const r = await api<{ devices: Device[] }>("GET", `/api/v1/people/${p.id}/devices`);
          print(r, table(["ID", "NAME", "VPN ADDRESS", "STATE"], r.devices.map((d) => [d.id, d.name, d.vpnIp, d.revokedAt ? `revoked ${day(d.revokedAt)}` : `valid until ${day(d.notAfter)}`])) || `${p.name} has no devices.\n`);
        } else throw new CliError("Usage: openasy-vpn devices <person>");
        return 0;
      }

      case "groups": {
        if (!sub) {
          const r = await api<{ groups: Group[] }>("GET", "/api/v1/groups");
          print(r, table(["NAME", "PEOPLE"], r.groups.map((g) => [g.name, String(g.people)])) || "No groups yet.\n");
        } else if (sub === "add") {
          need(3, "groups add <name>");
          const g = await api<Group>("POST", "/api/v1/groups", { name: args[2] });
          print(g, `Added the group ${g.name}.\n`);
        } else if (sub === "remove") {
          need(3, "groups remove <group>");
          const g = await byName<Group>("/api/v1/groups", "groups", args[2]!, "group");
          await api("DELETE", `/api/v1/groups/${g.id}`);
          print({ removed: g.id }, `Removed the group ${g.name}.\n`);
        } else throw new CliError(`Unknown command "groups ${sub}". Run openasy-vpn help.`);
        return 0;
      }

      case "ip-groups": {
        if (!sub) {
          const r = await api<{ ipGroups: IpGroup[] }>("GET", "/api/v1/ip-groups");
          const rows = r.ipGroups.map((g) => [g.name + (g.fullTunnel ? " (full tunnel)" : ""), g.networks.map((n) => (n.ports === "any" ? n.cidr : `${n.cidr}=${n.ports}`)).join(" "), g.allowedGroups.join(", ") || "nobody"]);
          print(r, table(["NAME", "NETWORKS", "WHO MAY REACH THEM"], rows) || "No IP groups yet.\n");
        } else if (sub === "add") {
          need(3, "ip-groups add <name> --network <cidr>[=<ports>]... [--allow <group>]... [--full-tunnel]");
          const networks = all("network").map((n) => {
            const [cidr, ports] = n.split(/=(.*)/s, 2);
            return { cidr: cidr!, ports: ports || "any" };
          });
          const g = await api<IpGroup>("POST", "/api/v1/ip-groups", { name: args[2], networks, allowedGroups: all("allow"), fullTunnel: has("full-tunnel") });
          print(g, `Added the IP group ${g.name}. Servers apply it within one heartbeat.\n`);
        } else if (sub === "remove") {
          need(3, "ip-groups remove <ip group>");
          const g = await byName<IpGroup>("/api/v1/ip-groups", "ipGroups", args[2]!, "IP group");
          await api("DELETE", `/api/v1/ip-groups/${g.id}`);
          print({ removed: g.id }, `Removed the IP group ${g.name}.\n`);
        } else throw new CliError(`Unknown command "ip-groups ${sub}". Run openasy-vpn help.`);
        return 0;
      }

      case "sessions": {
        if (!sub) {
          const r = await api<{ sessions: Session[] }>("GET", "/api/v1/sessions");
          const rows = r.sessions.map((s) => [s.personName ?? "?", s.deviceName ?? "?", s.deviceId, s.serverId, s.vpnIp, s.realAddress, s.connectedAt.slice(0, 16).replace("T", " "), `${bytes(s.bytesIn)} / ${bytes(s.bytesOut)}`]);
          print(r, table(["PERSON", "DEVICE", "DEVICE ID", "SERVER", "VPN ADDRESS", "FROM", "SINCE (UTC)", "IN / OUT"], rows) || "Nobody is connected.\n");
        } else if (sub === "end") {
          need(4, "sessions end <server> <device id>");
          await api("DELETE", `/api/v1/sessions/${encodeURIComponent(args[2]!)}/${encodeURIComponent(args[3]!)}`);
          print({ status: "accepted" }, "The server ends the session at its next heartbeat. To keep the device out, revoke it or suspend the person.\n");
        } else throw new CliError(`Unknown command "sessions ${sub}". Run openasy-vpn help.`);
        return 0;
      }

      case "servers": {
        const r = await api<{ servers: Server[] }>("GET", "/api/v1/servers");
        const rows = r.servers.map((s) => [s.id, s.listen ?? "udp/1194", s.version, s.openvpnRunning ? "running" : "stopped", s.configVersion ?? "not applied", s.lastSeen.slice(0, 19).replace("T", " ")]);
        print(r, table(["SERVER", "LISTENS ON", "VERSION", "OPENVPN", "CONFIG", "LAST HEARTBEAT (UTC)"], rows) || "No servers yet.\n");
        return 0;
      }

      default:
        throw new CliError(`Unknown command "${cmd}". Run openasy-vpn help.`);
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`${err.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), { env: process.env, out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
}
