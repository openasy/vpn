// Private keys at rest (ADR 0021): sealed in the database, in the clear only where they are used.
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { createKeyring } from "./kek.ts";
import { createCa, tlsCryptKey } from "./pki.ts";
import { startApp } from "./test-app.ts";
import { createVpn } from "./vpn.ts";

const setting = (db: ReturnType<typeof openDb>, key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value;

describe("keys at rest", () => {
  it("stores the CA, tls-crypt and server keys sealed, and hands them out in the clear", async () => {
    const app = await startApp({ version: "1.2.3" });
    expect(setting(app.db, "ca_key")).toMatch(/^v1\./);
    expect(setting(app.db, "tls_crypt")).toMatch(/^v1\./);
    expect(setting(app.db, "ca_cert")).toContain("BEGIN CERTIFICATE");

    const config = (await (await app.agent("/api/v1/servers/edge-1/config")).json()) as { key: string; tlsCrypt: string };
    expect(config.key).toContain("BEGIN PRIVATE KEY");
    expect(config.tlsCrypt).toContain("BEGIN OpenVPN Static key V1");
    const row = app.db.prepare("SELECT key FROM server_certs WHERE server_id = 'edge-1'").get() as { key: string };
    expect(row.key).toMatch(/^v1\./);
    // The same config on the next pull: the ETag must not move because sealing is randomised.
    const again = await app.agent("/api/v1/servers/edge-1/config");
    expect(((await again.json()) as { key: string }).key).toBe(config.key);

    const person = (await (await app.admin("/api/v1/people", { method: "POST", body: JSON.stringify({ name: "Dana Kim", email: "dana@example.com" }) })).json()) as { id: string };
    const { ovpn } = (await (await app.admin(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name: "Laptop" }) })).json()) as { ovpn: string };
    expect(ovpn).toContain(`<tls-crypt>\n${config.tlsCrypt.trim()}\n</tls-crypt>`);

    const dump = JSON.stringify(app.db.prepare("SELECT * FROM settings").all()) + JSON.stringify(app.db.prepare("SELECT * FROM server_certs").all());
    expect(dump).not.toContain("PRIVATE KEY");
    expect(dump).not.toContain("OpenVPN Static key");
    await app.close();
  });

  it("seals keys an earlier version stored in the clear, once, and keeps them", async () => {
    const db = openDb(":memory:");
    const ca = await createCa();
    const tls = tlsCryptKey();
    db.prepare("INSERT INTO settings (key, value) VALUES ('ca_cert', ?), ('ca_key', ?), ('tls_crypt', ?)").run(ca.cert, ca.key, tls);
    db.prepare("INSERT INTO server_certs (server_id, serial, cert, key, not_after) VALUES ('edge-1', '01', 'cert', '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', '2030-01-01T00:00:00.000Z')").run();
    const keyring = createKeyring(Buffer.alloc(32, 1));
    const vpn = createVpn(db, { network: "10.8.0.0/24", publicHost: "vpn.example.com", keyring });

    expect(await vpn.init()).toEqual({ sealed: 3 });
    expect(keyring.open(setting(db, "ca_key")).toString()).toBe(ca.key);
    expect(keyring.open(setting(db, "tls_crypt")).toString()).toBe(tls);
    expect(setting(db, "ca_cert")).toBe(ca.cert);
    expect(await vpn.init()).toEqual({ sealed: 0 });
    // The CA is the same one: certificates it issued before stay valid.
    expect((await vpn.serverConfig("edge-1")).ca).toBe(ca.cert);
  });

  it("does not start with another key-encryption key", async () => {
    const db = openDb(":memory:");
    await createVpn(db, { network: "10.8.0.0/24", keyring: createKeyring(Buffer.alloc(32, 1)) }).init();
    await expect(createVpn(db, { network: "10.8.0.0/24", keyring: createKeyring(Buffer.alloc(32, 2)) }).init()).rejects.toThrow(/does not open the CA key/);
  });
});
