import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { createKeyring } from "./kek.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
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

// The key-encryption key (ADR 0021) seals the CA key, server keys and sign-in secrets. It lives outside /data, so a
// copy of the volume or a backup holds none of them in the clear.
const secretsKeyFile = process.env.VPN_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
let kek: Buffer | undefined;
try {
  kek = readSecretsKey(secretsKeyFile);
} catch (err) {
  log("error", `the key-encryption key cannot be read: ${(err as Error).message}`, { file: secretsKeyFile });
  process.exit(1);
}
if (!kek) {
  log("error", "no key-encryption key: mount 32 random bytes (openssl rand -hex 32) and set VPN_SECRETS_KEY_FILE if not at the default", {
    file: secretsKeyFile,
  });
  process.exit(1);
}

const db = openDb(dbPath);

/**
 * Up to 0.4.0 only sign-in secrets were sealed, with the same key, and the CA key was in the clear. Before the CA key
 * is sealed for the first time, check that this key opens those secrets: a different key would seal the CA with a key
 * that opens nothing else. The format is @openasy/auth's: `v1:` and AES-256-GCM of iv, tag and data.
 */
function opensSignInSecrets(key: Buffer): boolean {
  let rows: Array<{ secret: string }>;
  try {
    rows = db.prepare("SELECT secret FROM auth_totp WHERE secret LIKE 'v1:%' LIMIT 3").all() as Array<{ secret: string }>;
  } catch {
    return true; // A new database: nothing was sealed yet.
  }
  return rows.every(({ secret }) => {
    try {
      const raw = Buffer.from(secret.slice(3), "base64url");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      Buffer.concat([d.update(raw.subarray(28)), d.final()]);
      return true;
    } catch {
      return false;
    }
  });
}
const caKey = db.prepare("SELECT value FROM settings WHERE key = 'ca_key'").get() as { value: string } | undefined;
if (caKey && !caKey.value.startsWith("v1.") && !opensSignInSecrets(kek)) {
  log(
    "error",
    "this key-encryption key does not open the sign-in secrets the earlier version sealed: mount the same openasy-kek as before. Nothing was changed",
    { file: secretsKeyFile },
  );
  process.exit(1);
}
const vpn = createVpn(db, { network: process.env.VPN_NETWORK ?? "10.8.0.0/24", publicHost: process.env.VPN_PUBLIC_HOST, version, keyring: createKeyring(kek) });
try {
  const { sealed } = await vpn.init();
  if (sealed) log("info", "sealed keys stored in the clear by an earlier version", { sealed });
} catch (err) {
  log("error", (err as Error).message, { file: secretsKeyFile });
  process.exit(1);
}
// The address people open vpn at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (env("VPN_PUBLIC_URL") ?? `http://localhost:${port}`).replace(/\/$/, "");
const auth = createAuth({
  db,
  product: "vpn",
  productName: "OpenAsy VPN",
  origin: publicUrl,
  // Locally the same vpn is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.VPN_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "VPN_"),
  secretsKey: kek,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" || event.type === "session-ended" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
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
    products: products.products,
  }),
);

server.listen(port, () => log("info", "vpn started", { version, port, db: dbPath, headless }));
if (process.env.VPN_SERVER_TOKEN)
  log("warn", "VPN_SERVER_TOKEN is deprecated: add each server under Servers and start it with its own VPN_ENROLL_TOKEN, then remove VPN_SERVER_TOKEN");
if (process.env.VPN_ADMIN_TOKEN)
  log("warn", "VPN_ADMIN_TOKEN is deprecated: it is one shared admin token without an expiry. Create API tokens under Settings and remove it");
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "VPN_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put vpn behind TLS (ADR 0026)", { url: publicUrl });
}
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
