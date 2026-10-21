// The command line tool against the real API (ADR 0014).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, startApp } from "../server/test-app.ts";
import { run } from "./openasy-vpn.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "1.2.3" });
});
afterAll(() => app.close());

async function cli(argv: string[], env: Record<string, string | undefined> = {}) {
  let out = "";
  let err = "";
  const files = new Map<string, string>();
  const code = await run(argv, {
    env: { VPN_URL: app.base, VPN_API_TOKEN: ADMIN_TOKEN, ...env },
    out: (t) => (out += t),
    err: (t) => (err += t),
    writeFile: (path, data) => {
      if (files.has(path) || path.includes("exists")) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, data);
    },
  });
  return { code, out, err, files };
}

describe("openasy-vpn", () => {
  it("prints help, and refuses unknown commands", async () => {
    expect((await cli(["help"])).out).toContain("Usage: openasy-vpn <command>");
    const r = await cli(["nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown command "nope"');
  });

  it("asks for a token, and says when vpn cannot be reached", async () => {
    expect((await cli(["people"], { VPN_API_TOKEN: undefined })).err).toContain("Set VPN_API_TOKEN");
    const r = await cli(["people"], { VPN_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot reach http://127.0.0.1:1");
    expect((await cli(["people"], { VPN_API_TOKEN: "wrong" })).code).toBe(1);
  });

  it("gives someone access from start to end", async () => {
    expect((await cli(["groups", "add", "Backend engineers"])).out).toBe("Added the group Backend engineers.\n");
    const ig = await cli(["ip-groups", "add", "Production databases", "--network", "172.16.20.0/24=tcp/5432,6432", "--network=10.1.0.0/16", "--allow", "Backend engineers"]);
    expect(ig.code).toBe(0);
    expect((await cli(["ip-groups"])).out).toMatch(/Production databases\s+172\.16\.20\.0\/24=tcp\/5432,6432 10\.1\.0\.0\/16\s+Backend engineers/);

    expect((await cli(["people", "add", "Dana Kim", "dana@example.com", "--group", "Backend engineers"])).out).toContain("Added Dana Kim.");
    expect((await cli(["people"])).out).toMatch(/Dana Kim\s+dana@example.com\s+active\s+0\s+Backend engineers/);

    const dev = await cli(["devices", "add", "DANA@example.com", "Work laptop"]);
    expect(dev.code).toBe(0);
    expect(dev.out).toContain("Wrote dana-kim-work-laptop.ovpn");
    expect(dev.files.get("dana-kim-work-laptop.ovpn")).toContain("BEGIN PRIVATE KEY");

    const printed = await cli(["devices", "add", "dana@example.com", "Phone", "--out", "-"]);
    expect(printed.out).toMatch(/^# OpenAsy VPN: Dana Kim, Phone/);

    const json = JSON.parse((await cli(["devices", "dana@example.com", "--json"])).out) as { devices: Array<{ id: string; name: string }> };
    expect(json.devices.map((d) => d.name)).toEqual(["Work laptop", "Phone"]);
    expect((await cli(["devices", "revoke", json.devices[1]!.id])).out).toContain("Revoked Phone");
    expect((await cli(["devices", "dana@example.com"])).out).toMatch(/Phone\s+10\.8\.0\.\d+\s+revoked/);

    expect((await cli(["people", "suspend", "dana@example.com"])).out).toContain("Suspended Dana Kim");
    expect((await cli(["people", "show", "dana@example.com"])).out).toContain("status   suspended");
    expect((await cli(["people", "activate", "dana@example.com"])).out).toContain("active again");
    expect((await cli(["people", "groups", "dana@example.com"])).out).toBe("Dana Kim is in no group.\n");
  });

  it("prints the file instead of losing it when it cannot be written", async () => {
    const r = await cli(["devices", "add", "dana@example.com", "Tablet", "--out", "exists.ovpn"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Could not write exists.ovpn (EEXIST)");
    expect(r.out).toContain("BEGIN PRIVATE KEY");
  });

  it("shows the API's reason when something is refused", async () => {
    const r = await cli(["ip-groups", "add", "Bad", "--network", "300.1.1.0/24"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"300.1.1.0/24" is not an IPv4 network');
    expect((await cli(["people", "show", "nobody@example.com"])).err).toContain('Nobody with the email or id "nobody@example.com"');
  });

  it("lists sessions and servers, and ends a session", async () => {
    const devices = JSON.parse((await cli(["devices", "dana@example.com", "--json"])).out) as { devices: Array<{ id: string; vpnIp: string }> };
    const d = devices.devices[0]!;
    const heartbeat = (sessions: unknown[]) =>
      app.agent("/api/v1/servers/heartbeat", { method: "POST", body: JSON.stringify({ id: "edge-1", version: "1.2.3", listen: "udp/1194", openvpnRunning: true, sessions }) });
    const live = [{ cn: d.id, realAddress: "203.0.113.7:51820", vpnIp: d.vpnIp, bytesIn: 2048, bytesOut: 10, connectedAt: new Date().toISOString() }];
    await heartbeat(live);
    expect((await cli(["servers"])).out).toMatch(/edge-1 \(legacy\)\s+online\s+default\s+udp\/1194\s+1\.2\.3\s+running/);
    expect((await cli(["sessions"])).out).toMatch(/Dana Kim\s+Work laptop\s+\S+\s+edge-1\s+10\.8\.0\.\d+\s+203\.0\.113\.7:51820/);
    expect((await cli(["sessions", "end", "edge-1", d.id])).code).toBe(0);
    expect(((await (await heartbeat(live)).json()) as { disconnect: string[] }).disconnect).toEqual([d.id]);
  });

  it("adds a server, prints its token once, and removes it", async () => {
    const added = await cli(["servers", "add", "FRA-1", "--address", "fra.vpn.example.com"]);
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/Added the server fra-1\. Start vpn-server on fra\.vpn\.example\.com .*\n\n {2}VPN_ENROLL_TOKEN=ove_\S+\n/);
    expect((await cli(["servers"])).out).toMatch(/fra-1\s+waiting-to-enrol\s+fra\.vpn\.example\.com\s+-\s+-\s+stopped\s+not applied\s+never/);
    expect((await cli(["servers", "address", "fra-1"])).out).toContain("fra-1 is at VPN_PUBLIC_HOST");
    expect((await cli(["servers", "enroll", "fra-1"])).out).toContain("VPN_ENROLL_TOKEN=ove_");
    expect((await cli(["servers", "add", "fra-1"])).err).toContain("A server named fra-1 exists");
    expect((await cli(["servers", "remove", "fra-1"])).out).toContain("Removed the server fra-1");
    expect((await cli(["servers", "remove", "fra-1"])).err).toContain("Server does not exist");
  });

  it("removes what it added", async () => {
    expect((await cli(["people", "remove", "dana@example.com"])).out).toContain("Removed Dana Kim");
    expect((await cli(["ip-groups", "remove", "production databases"])).code).toBe(0);
    expect((await cli(["groups", "remove", "Backend engineers"])).code).toBe(0);
    expect((await cli(["people"])).out).toBe("Nobody yet.\n");
  });
});
