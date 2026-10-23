import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vpn-")), "nested", "vpn.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 4 });
    second.close();
  });

  it("keeps servers from before enrolment as legacy", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vpn-")), "vpn.db");
    // A 0.5.0 database: two migrations and a server that reported with VPN_SERVER_TOKEN.
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    old.exec("CREATE TABLE servers (id TEXT PRIMARY KEY, version TEXT NOT NULL, listen TEXT, openvpn_running INTEGER NOT NULL, last_seen TEXT NOT NULL)");
    old.exec("ALTER TABLE servers ADD COLUMN config_version TEXT");
    // The tables a later migration changes, as 0.5.0 had them.
    old.exec("CREATE TABLE ip_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, full_tunnel INTEGER NOT NULL DEFAULT 0)");
    old.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
    old.exec("INSERT INTO schema_migrations VALUES (1, 'x'), (2, 'x')");
    old.exec("INSERT INTO servers VALUES ('edge-1', '0.5.0', 'udp/1194', 1, '2026-10-01T00:00:00.000Z', 'abc')");
    old.close();

    const db = openDb(path);
    expect(
      db.prepare("SELECT id, address, legacy, secret_hash, version, listen, openvpn_running, config_version, last_seen, created_at FROM servers").all(),
    ).toEqual([
      {
        id: "edge-1",
        address: null,
        legacy: 1,
        secret_hash: null,
        version: "0.5.0",
        listen: "udp/1194",
        openvpn_running: 1,
        config_version: "abc",
        last_seen: "2026-10-01T00:00:00.000Z",
        created_at: "2026-10-01T00:00:00.000Z",
      },
    ]);
    db.close();
  });
});
