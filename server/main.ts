import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createVpn } from "./vpn.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.VPN_MANAGER_DB ?? "/data/vpn-manager.db";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.VPN_MANAGER_HEADLESS === "true";

const db = openDb(dbPath);
const vpn = createVpn(db, { network: process.env.VPN_NETWORK ?? "10.8.0.0/24", publicHost: process.env.VPN_PUBLIC_HOST });
await vpn.init();
const server = createServer(
  createApp({
    db,
    vpn,
    version,
    serverToken: process.env.VPN_SERVER_TOKEN,
    adminToken: process.env.VPN_ADMIN_TOKEN,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
  }),
);

server.listen(port, () => log("info", "vpn-manager started", { version, port, db: dbPath, headless }));
if (!process.env.VPN_SERVER_TOKEN) log("warn", "VPN_SERVER_TOKEN is not set; vpn-server agents will be refused");
if (!process.env.VPN_ADMIN_TOKEN) log("warn", "VPN_ADMIN_TOKEN is not set; the management API and UI will refuse every request");
if (!process.env.VPN_PUBLIC_HOST) log("warn", "VPN_PUBLIC_HOST is not set; devices cannot be added until it names the address clients connect to");
// Until sign-in and encrypted secrets exist (ADR 0002, 0021), this release is for test environments only.
log("warn", "the CA key is stored unencrypted in the database and the management API uses one shared token: use this release only for testing");

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
