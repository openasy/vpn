import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE servers (
     id TEXT PRIMARY KEY,
     version TEXT NOT NULL,
     listen TEXT,
     openvpn_running INTEGER NOT NULL,
     last_seen TEXT NOT NULL
   )`,
  // 0.2.0: the VPN itself. People and their devices, groups, IP groups, the CA and server certificates.
  `ALTER TABLE servers ADD COLUMN config_version TEXT;
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE people (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
     created_at TEXT NOT NULL
   );
   CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
   CREATE TABLE person_groups (
     person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
     group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
     PRIMARY KEY (person_id, group_id)
   );
   CREATE TABLE ip_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, full_tunnel INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE ip_group_networks (
     ip_group_id TEXT NOT NULL REFERENCES ip_groups (id) ON DELETE CASCADE,
     cidr TEXT NOT NULL,
     ports TEXT NOT NULL DEFAULT 'any',
     note TEXT NOT NULL DEFAULT ''
   );
   CREATE TABLE ip_group_access (
     ip_group_id TEXT NOT NULL REFERENCES ip_groups (id) ON DELETE CASCADE,
     group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
     PRIMARY KEY (ip_group_id, group_id)
   );
   CREATE TABLE devices (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     serial TEXT NOT NULL UNIQUE,
     vpn_ip TEXT NOT NULL,
     cert TEXT NOT NULL,
     not_after TEXT NOT NULL,
     created_at TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE UNIQUE INDEX devices_active_ip ON devices (vpn_ip) WHERE revoked_at IS NULL;
   CREATE TABLE server_certs (server_id TEXT PRIMARY KEY, serial TEXT NOT NULL, cert TEXT NOT NULL, key TEXT NOT NULL, not_after TEXT NOT NULL);
   -- Revocations outlive the devices they revoke, so a deleted person's certificates stay revoked.
   CREATE TABLE revocations (serial TEXT PRIMARY KEY, revoked_at TEXT NOT NULL);
   -- Live connections as each server last reported them, and disconnects waiting for the next heartbeat.
   CREATE TABLE sessions (
     server_id TEXT NOT NULL,
     cn TEXT NOT NULL,
     real_address TEXT NOT NULL,
     vpn_ip TEXT NOT NULL,
     bytes_in INTEGER NOT NULL,
     bytes_out INTEGER NOT NULL,
     connected_at TEXT NOT NULL,
     PRIMARY KEY (server_id, cn)
   );
   CREATE TABLE pending_disconnects (server_id TEXT NOT NULL, cn TEXT NOT NULL, PRIMARY KEY (server_id, cn))`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
