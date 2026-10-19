// Starts the app on a random port for tests.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { createVpn } from "./vpn.ts";

export const SERVER_TOKEN = "test-server-token";
export const ADMIN_TOKEN = "test-admin-token";

export async function startApp(opts: Partial<AppOptions> & { version: string; publicHost?: string }) {
  const db = openDb(":memory:");
  const vpn = createVpn(db, { network: "10.8.0.0/24", publicHost: "publicHost" in opts ? opts.publicHost : "vpn.example.com" });
  await vpn.init();
  const server: Server = createServer(createApp({ db, vpn, serverToken: SERVER_TOKEN, adminToken: ADMIN_TOKEN, ...opts }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const agent = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${SERVER_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, vpn, base, admin, agent, close };
}
