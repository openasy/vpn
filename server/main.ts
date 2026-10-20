import { existsSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createVpn } from "./vpn.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
// Until 0.4.0 the product was vpn-manager. Its variable names work until 0.5.0, and its database file moves once.
function env(name: string): string | undefined {
  const old = name.replace(/^VPN_/, "VPN_MANAGER_");
  if (process.env[name] !== undefined || process.env[old] === undefined) return process.env[name];
  log("warn", `${old} is deprecated: rename it to ${name}`);
  return process.env[old];
}
function defaultDb(): string {
  const path = "/data/vpn.db";
  const old = "/data/vpn-manager.db";
  if (!existsSync(path) && existsSync(old)) {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(old + suffix)) renameSync(old + suffix, path + suffix);
    log("info", "moved the database to its new name", { from: old, to: path });
  }
  return path;
}
const dbPath = env("VPN_DB") ?? defaultDb();
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = env("VPN_HEADLESS") === "true";

const db = openDb(dbPath);
const vpn = createVpn(db, { network: process.env.VPN_NETWORK ?? "10.8.0.0/24", publicHost: process.env.VPN_PUBLIC_HOST });
await vpn.init();
// The address people open vpn at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (env("VPN_PUBLIC_URL") ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.VPN_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "vpn",
  productName: "OpenAsy VPN",
  origin: publicUrl,
  // Locally the same vpn is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.VPN_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "VPN_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" || event.type === "session-ended" ? "warn" : "info", "auth", { event }),
});
const server = createServer(
  createApp({
    db,
    vpn,
    version,
    auth,
    serverToken: process.env.VPN_SERVER_TOKEN,
    adminToken: process.env.VPN_ADMIN_TOKEN || undefined,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
  }),
);

server.listen(port, () => log("info", "vpn started", { version, port, db: dbPath, headless }));
if (!process.env.VPN_SERVER_TOKEN) log("warn", "VPN_SERVER_TOKEN is not set; vpn-server agents will be refused");
if (process.env.VPN_ADMIN_TOKEN) log("warn", "VPN_ADMIN_TOKEN is deprecated: it is one shared admin token without an expiry. Create API tokens under Settings and remove it");
if (!process.env.VPN_PUBLIC_HOST) log("warn", "VPN_PUBLIC_HOST is not set; devices cannot be added until it names the address clients connect to");
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "VPN_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put vpn behind TLS (ADR 0026)", { url: publicUrl });
}
if (auth.secretsInClear) log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
// Until the CA key is encrypted (ADR 0021), keep the data volume as safe as the CA itself.
log("warn", "the CA key is stored unencrypted in the database: protect the /data volume and its backups");
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });
const purge = setInterval(() => auth.purge(), 5 * 60_000);

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  clearInterval(purge);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
