// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { createKeyring } from "./kek.ts";
import { openDb } from "./db.ts";
import { createVpn } from "./vpn.ts";

export const SERVER_TOKEN = "test-server-token";
export const ADMIN_TOKEN = "test-admin-token";

export const KEK = Buffer.alloc(32, 7);

export async function startApp(opts: Partial<AppOptions> & { version: string; publicHost?: string }) {
  const db = openDb(":memory:");
  const vpn = createVpn(db, { network: "10.8.0.0/24", publicHost: "publicHost" in opts ? opts.publicHost : "vpn.example.com", keyring: createKeyring(KEK) });
  await vpn.init();
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "vpn", productName: "OpenAsy VPN", origin: base, secretsKey: KEK });
  handler = createApp({ db, vpn, auth, serverToken: SERVER_TOKEN, adminToken: ADMIN_TOKEN, ...opts });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const agent = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${SERVER_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, vpn, auth, base, admin, agent, close };
}
