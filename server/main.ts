import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.VPN_MANAGER_DB ?? "/data/vpn-manager.db";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const headless = process.env.VPN_MANAGER_HEADLESS === "true";

const db = openDb(dbPath);
const server = createServer(
  createApp({
    db,
    version,
    serverToken: process.env.VPN_SERVER_TOKEN,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
  }),
);

server.listen(port, () => log("info", "vpn-manager started", { version, port, db: dbPath, headless }));
if (!process.env.VPN_SERVER_TOKEN) log("warn", "VPN_SERVER_TOKEN is not set; vpn-server heartbeats will be refused");

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
