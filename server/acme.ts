// ACME (RFC 8555) for the internal CA (ADR 0054): Caddy, certbot and cert-manager inside get and renew certificates
// for names under the install's domain by themselves. Accounts need a key an admin made (External Account Binding), so
// a device on the VPN cannot open one; a name is proven with http-01 at the address its internal record gives.
// Wildcards need dns-01, which this does not offer: they are issued under Access, Internal CA.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

export interface AcmeOptions {
  db: DatabaseSync;
  /** The install's internal domain, or undefined when it has none. */
  domain: () => string | undefined;
  /** The addresses an internal name resolves to, following aliases inside the zone. */
  addresses: (name: string) => string[];
  /** The HMAC key of an External Account Binding key id, or undefined when there is no such key. */
  macKey: (kid: string) => Buffer | undefined;
  /** Issues for a CSR, which must name exactly these names: the chain as PEM, or why not. */
  issue: (csr: Uint8Array, names: string[]) => Promise<{ chain: string } | { error: string }>;
  /** Where http-01 is checked: 80, as RFC 8555 says; tests use another. */
  httpPort?: number;
  log?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

const ORDER_TTL_MS = 7 * 864e5;
const NONCE_TTL_MS = 30 * 60_000;
const MAX_BODY = 64 * 1024;

class AcmeError extends Error {
  readonly status: number;
  readonly type: string;
  constructor(status: number, type: string, detail: string) {
    super(detail);
    this.status = status;
    this.type = type;
  }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const unb64u = (s: unknown) => (typeof s === "string" && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, "base64url") : undefined);
const parse = (b: Buffer | undefined) => {
  try {
    return b ? (JSON.parse(b.toString("utf8")) as unknown) : undefined;
  } catch {
    return undefined;
  }
};

type Jwk = { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string };

/** RFC 7638 thumbprint: the key's required members in order, hashed. */
export function thumbprint(jwk: Jwk): string {
  const members = jwk.kty === "EC" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return b64u(createHash("sha256").update(JSON.stringify(members)).digest());
}

async function verifySignature(alg: string, jwk: Jwk, data: string, signature: Buffer): Promise<boolean> {
  try {
    if (alg === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") {
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(signature), new TextEncoder().encode(data));
    }
    if (alg === "RS256" && jwk.kty === "RSA") {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, new Uint8Array(signature), new TextEncoder().encode(data));
    }
  } catch {
    // A key that cannot be imported verifies nothing.
  }
  return false;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new AcmeError(400, "malformed", "The request is too large."));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface Order {
  id: string;
  account_id: string;
  names: string;
  status: "pending" | "ready" | "valid" | "invalid";
  expires: string;
  cert: string | null;
}
interface Authz {
  id: string;
  order_id: string;
  name: string;
  status: "pending" | "valid" | "invalid";
  token: string;
  validated_at: string | null;
  error: string | null;
}

export function createAcme(opts: AcmeOptions) {
  const { db } = opts;
  const nonces = new Map<string, number>();
  const newNonce = () => {
    const now = Date.now();
    for (const [n, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(n);
    const n = b64u(randomBytes(16));
    nonces.set(n, now);
    return n;
  };

  /** The address the client used, so every URL in a request and an answer matches it (RFC 8555 6.4). */
  const origin = (req: IncomingMessage) => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host ?? "localhost"}`;

  function send(res: ServerResponse, status: number, body: unknown, base: string, headers: Record<string, string> = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": typeof body === "string" ? "application/pem-certificate-chain" : "application/json",
      "content-length": Buffer.byteLength(text),
      "replay-nonce": newNonce(),
      "cache-control": "no-store",
      link: `<${base}/acme/directory>;rel="index"`,
      ...headers,
    });
    res.end(text);
  }

  const orderJson = (o: Order, base: string) => {
    const authzs = db.prepare("SELECT id FROM acme_authz WHERE order_id = ? ORDER BY rowid").all(o.id) as Array<{ id: string }>;
    return {
      status: o.status,
      expires: o.expires,
      identifiers: (JSON.parse(o.names) as string[]).map((value) => ({ type: "dns", value })),
      authorizations: authzs.map((a) => `${base}/acme/authz/${a.id}`),
      finalize: `${base}/acme/order/${o.id}/finalize`,
      ...(o.cert && { certificate: `${base}/acme/cert/${o.id}` }),
    };
  };

  const challengeJson = (a: Authz, base: string) => ({
    type: "http-01",
    url: `${base}/acme/chall/${a.id}`,
    token: a.token,
    status: a.status === "pending" ? "pending" : a.status,
    ...(a.validated_at && { validated: a.validated_at }),
    ...(a.error && { error: { type: "urn:ietf:params:acme:error:incorrectResponse", detail: a.error } }),
  });

  const authzJson = (a: Authz, base: string) => ({
    identifier: { type: "dns", value: a.name },
    status: a.status,
    expires: (db.prepare("SELECT expires FROM acme_orders WHERE id = ?").get(a.order_id) as { expires: string }).expires,
    challenges: [challengeJson(a, base)],
  });

  /** The order's status from its authorizations, once none is pending any more. */
  function settle(orderId: string) {
    const states = (db.prepare("SELECT status FROM acme_authz WHERE order_id = ?").all(orderId) as Array<{ status: string }>).map((r) => r.status);
    const next = states.includes("invalid") ? "invalid" : states.every((s) => s === "valid") ? "ready" : "pending";
    db.prepare("UPDATE acme_orders SET status = ? WHERE id = ? AND status IN ('pending', 'ready')").run(next, orderId);
  }

  /** http-01: the key authorization, served by the host the name's internal record points to. */
  async function validate(a: Authz, keyAuthorization: string): Promise<string | undefined> {
    const addresses = opts.addresses(a.name);
    if (!addresses.length) return `${a.name} has no internal address to check.`;
    const port = opts.httpPort ?? 80;
    const reasons: string[] = [];
    for (const address of addresses) {
      // node:http rather than fetch: the request must carry the name as Host, as a browser's would.
      const got = await new Promise<{ status: number; body: string } | { error: string }>((resolve) => {
        const req = httpRequest({ host: address, port, path: `/.well-known/acme-challenge/${a.token}`, headers: { host: a.name }, timeout: 5000 }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d: string) => body.length < 4096 && (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("timeout", () => req.destroy(new Error("timed out")));
        req.on("error", (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
        req.end();
      });
      if ("error" in got) reasons.push(`${address}: ${got.error}`);
      else if (got.status === 200 && got.body.trim() === keyAuthorization) return undefined;
      else reasons.push(`${address} answered ${got.status}${got.status === 200 ? " with another key authorization" : ""}`);
    }
    return `http://${a.name}/.well-known/acme-challenge/${a.token}: ${reasons.join("; ")}.`;
  }

  /** Checks a JWS request (RFC 8555 6.2): signature, nonce, URL, and the account or the new key. */
  async function request(req: IncomingMessage, url: string, newAccount: boolean) {
    const jws = parse(await readBody(req)) as { protected?: string; payload?: string; signature?: string } | undefined;
    if (!jws || typeof jws.protected !== "string" || typeof jws.payload !== "string" || typeof jws.signature !== "string")
      throw new AcmeError(400, "malformed", "The body is a flattened JWS: protected, payload and signature.");
    const header = parse(unb64u(jws.protected)) as { alg?: string; nonce?: string; url?: string; jwk?: Jwk; kid?: string } | undefined;
    if (!header) throw new AcmeError(400, "malformed", "The protected header is not base64url JSON.");
    if (header.alg !== "ES256" && header.alg !== "RS256") throw new AcmeError(400, "badSignatureAlgorithm", "Sign with ES256 or RS256.");
    if (!header.nonce || !nonces.delete(header.nonce)) throw new AcmeError(400, "badNonce", "The nonce is unknown or used; get a new one.");
    if (header.url !== url) throw new AcmeError(401, "unauthorized", `The url in the header must be ${url}.`);
    let account: { id: string; jwk: string; status: string } | undefined;
    let jwk: Jwk;
    if (newAccount) {
      if (!header.jwk || header.kid) throw new AcmeError(400, "malformed", "A new account is signed with its key as jwk, without kid.");
      jwk = header.jwk;
    } else {
      if (!header.kid || header.jwk) throw new AcmeError(400, "malformed", "Sign with the account's kid, not a jwk.");
      const id = header.kid.slice(header.kid.lastIndexOf("/") + 1);
      account = db.prepare("SELECT id, jwk, status FROM acme_accounts WHERE id = ?").get(id) as typeof account;
      if (!account || header.kid !== `${url.slice(0, url.indexOf("/acme/"))}/acme/account/${id}`)
        throw new AcmeError(400, "accountDoesNotExist", "No such account.");
      if (account.status !== "valid") throw new AcmeError(401, "unauthorized", "The account is deactivated.");
      jwk = JSON.parse(account.jwk) as Jwk;
    }
    const signature = unb64u(jws.signature);
    if (!signature || !(await verifySignature(header.alg, jwk, `${jws.protected}.${jws.payload}`, signature)))
      throw new AcmeError(400, "malformed", "The signature does not verify.");
    const payload = jws.payload === "" ? undefined : parse(unb64u(jws.payload));
    if (jws.payload !== "" && payload === undefined) throw new AcmeError(400, "malformed", "The payload is not base64url JSON.");
    return { jwk, account, payload: payload as Record<string, unknown> | undefined };
  }

  const ownOrder = (id: string, accountId: string) => {
    const o = db.prepare("SELECT * FROM acme_orders WHERE id = ?").get(id) as Order | undefined;
    if (!o || o.account_id !== accountId) throw new AcmeError(404, "malformed", "No such order.");
    if (o.status !== "valid" && Date.parse(o.expires) < Date.now()) {
      db.prepare("UPDATE acme_orders SET status = 'invalid' WHERE id = ?").run(o.id);
      o.status = "invalid";
    }
    return o;
  };
  const ownAuthz = (id: string, accountId: string) => {
    const a = db.prepare("SELECT * FROM acme_authz WHERE id = ?").get(id) as Authz | undefined;
    if (!a) throw new AcmeError(404, "malformed", "No such authorization.");
    ownOrder(a.order_id, accountId);
    return a;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!path.startsWith("/acme/")) return undefined;
    const base = origin(req);
    const url = `${base}${path}`;
    try {
      const domain = opts.domain();
      if (!domain) throw new AcmeError(404, "malformed", "No internal domain: set VPN_DNS_DOMAIN to issue certificates.");
      if (path === "/acme/directory" && req.method === "GET") {
        send(
          res,
          200,
          {
            newNonce: `${base}/acme/new-nonce`,
            newAccount: `${base}/acme/new-account`,
            newOrder: `${base}/acme/new-order`,
            meta: { externalAccountRequired: true, website: "https://openasy.github.io/products/vpn" },
          },
          base,
        );
        return "/acme/directory";
      }
      if (path === "/acme/new-nonce" && (req.method === "HEAD" || req.method === "GET")) {
        res
          .writeHead(req.method === "HEAD" ? 200 : 204, {
            "replay-nonce": newNonce(),
            "cache-control": "no-store",
            link: `<${base}/acme/directory>;rel="index"`,
          })
          .end();
        return "/acme/new-nonce";
      }
      if (req.method !== "POST") throw new AcmeError(405, "malformed", "ACME requests are POSTs of a JWS.");

      if (path === "/acme/new-account") {
        const { jwk, payload } = await request(req, url, true);
        const print = thumbprint(jwk);
        const existing = db.prepare("SELECT id FROM acme_accounts WHERE thumbprint = ?").get(print) as { id: string } | undefined;
        const account = (id: string) => ({ status: "valid", contact: [], orders: `${base}/acme/account/${id}/orders` });
        if (existing) {
          send(res, 200, account(existing.id), base, { location: `${base}/acme/account/${existing.id}` });
          return "/acme/new-account";
        }
        if (payload?.onlyReturnExisting === true) throw new AcmeError(400, "accountDoesNotExist", "No account for this key.");
        // External Account Binding (RFC 8555 7.3.4): the account key, signed with a key an admin made under Access.
        const eab = payload?.externalAccountBinding as { protected?: string; payload?: string; signature?: string } | undefined;
        if (!eab || typeof eab.protected !== "string" || typeof eab.payload !== "string" || typeof eab.signature !== "string")
          throw new AcmeError(401, "externalAccountRequired", "Bind the account to an ACME key from VPN, Access, Internal CA.");
        const eabHeader = parse(unb64u(eab.protected)) as { alg?: string; kid?: string; url?: string } | undefined;
        const mac = eabHeader?.kid ? opts.macKey(eabHeader.kid) : undefined;
        const bound = parse(unb64u(eab.payload)) as Jwk | undefined;
        const signature = unb64u(eab.signature);
        const expected = mac && createHmac("sha256", mac).update(`${eab.protected}.${eab.payload}`).digest();
        if (
          eabHeader?.alg !== "HS256" ||
          eabHeader.url !== url ||
          !expected ||
          !signature ||
          signature.length !== expected.length ||
          !timingSafeEqual(signature, expected) ||
          !bound ||
          thumbprint(bound) !== print
        )
          throw new AcmeError(401, "unauthorized", "The external account binding does not verify: check the key id and HMAC key.");
        const id = randomUUID();
        db.prepare("INSERT INTO acme_accounts (id, thumbprint, jwk, key_id, status, created_at) VALUES (?, ?, ?, ?, 'valid', ?)").run(
          id,
          print,
          JSON.stringify(jwk),
          eabHeader.kid!,
          new Date().toISOString(),
        );
        db.prepare("UPDATE acme_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), eabHeader.kid!);
        opts.log?.("info", "ACME account made", { account: id, key: eabHeader.kid });
        send(res, 201, account(id), base, { location: `${base}/acme/account/${id}` });
        return "/acme/new-account";
      }

      const { account, payload } = await request(req, url, false);
      const acct = account!;
      let m: RegExpMatchArray | null;

      if ((m = path.match(/^\/acme\/account\/([\w-]+)$/))) {
        if (m[1] !== acct.id) throw new AcmeError(401, "unauthorized", "Not this account.");
        if (payload?.status === "deactivated") db.prepare("UPDATE acme_accounts SET status = 'deactivated' WHERE id = ?").run(acct.id);
        send(
          res,
          200,
          { status: payload?.status === "deactivated" ? "deactivated" : "valid", contact: [], orders: `${base}/acme/account/${acct.id}/orders` },
          base,
        );
        return "/acme/account";
      }
      if ((m = path.match(/^\/acme\/account\/([\w-]+)\/orders$/))) {
        if (m[1] !== acct.id) throw new AcmeError(401, "unauthorized", "Not this account.");
        const ids = db.prepare("SELECT id FROM acme_orders WHERE account_id = ? AND status != 'invalid' ORDER BY rowid DESC LIMIT 100").all(acct.id) as Array<{
          id: string;
        }>;
        send(res, 200, { orders: ids.map((o) => `${base}/acme/order/${o.id}`) }, base);
        return "/acme/account/orders";
      }

      if (path === "/acme/new-order") {
        const ids = payload?.identifiers;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20) throw new AcmeError(400, "malformed", "identifiers is a list of 1 to 20 dns names.");
        const names = [
          ...new Set(
            ids.map((i: { type?: unknown; value?: unknown }) =>
              i?.type === "dns" && typeof i.value === "string" ? i.value.toLowerCase().replace(/\.$/, "") : "",
            ),
          ),
        ];
        for (const n of names) {
          if (n.startsWith("*."))
            throw new AcmeError(
              400,
              "rejectedIdentifier",
              `${n}: wildcards need dns-01, which this CA does not offer; issue them under VPN, Access, Internal CA.`,
            );
          if (!n || !(n === domain || n.endsWith(`.${domain}`)))
            throw new AcmeError(400, "rejectedIdentifier", `${n || "an identifier"} is not a name under ${domain}.`);
        }
        const id = randomUUID();
        const expires = new Date(Date.now() + ORDER_TTL_MS).toISOString();
        db.exec("BEGIN");
        try {
          db.prepare("INSERT INTO acme_orders (id, account_id, names, status, expires, created_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(
            id,
            acct.id,
            JSON.stringify(names),
            expires,
            new Date().toISOString(),
          );
          for (const n of names)
            db.prepare("INSERT INTO acme_authz (id, order_id, name, status, token) VALUES (?, ?, ?, 'pending', ?)").run(
              randomUUID(),
              id,
              n,
              b64u(randomBytes(32)),
            );
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        send(res, 201, orderJson(ownOrder(id, acct.id), base), base, { location: `${base}/acme/order/${id}` });
        return "/acme/new-order";
      }
      if ((m = path.match(/^\/acme\/order\/([\w-]+)$/))) {
        send(res, 200, orderJson(ownOrder(m[1]!, acct.id), base), base);
        return "/acme/order";
      }
      if ((m = path.match(/^\/acme\/authz\/([\w-]+)$/))) {
        send(res, 200, authzJson(ownAuthz(m[1]!, acct.id), base), base);
        return "/acme/authz";
      }
      if ((m = path.match(/^\/acme\/chall\/([\w-]+)$/))) {
        let a = ownAuthz(m[1]!, acct.id);
        if (a.status === "pending" && payload !== undefined) {
          const error = await validate(a, `${a.token}.${thumbprint(JSON.parse(acct.jwk) as Jwk)}`);
          db.prepare("UPDATE acme_authz SET status = ?, validated_at = ?, error = ? WHERE id = ?").run(
            error ? "invalid" : "valid",
            error ? null : new Date().toISOString(),
            error ?? null,
            a.id,
          );
          if (error) opts.log?.("warn", "ACME challenge failed", { name: a.name, error });
          settle(a.order_id);
          a = ownAuthz(a.id, acct.id);
        }
        send(res, 200, challengeJson(a, base), base, { link: `<${base}/acme/authz/${a.id}>;rel="up", <${base}/acme/directory>;rel="index"` });
        return "/acme/chall";
      }
      if ((m = path.match(/^\/acme\/order\/([\w-]+)\/finalize$/))) {
        const o = ownOrder(m[1]!, acct.id);
        if (o.status !== "ready") throw new AcmeError(403, "orderNotReady", `The order is ${o.status}: every authorization must be valid first.`);
        const csr = unb64u(payload?.csr);
        if (!csr?.length) throw new AcmeError(400, "badCSR", "csr is the CSR as base64url DER.");
        const out = await opts.issue(csr, JSON.parse(o.names) as string[]);
        if ("error" in out) throw new AcmeError(400, "badCSR", out.error);
        db.prepare("UPDATE acme_orders SET status = 'valid', cert = ? WHERE id = ?").run(out.chain, o.id);
        opts.log?.("info", "ACME certificate issued", { names: o.names, account: acct.id });
        send(res, 200, orderJson(ownOrder(o.id, acct.id), base), base, { location: `${base}/acme/order/${o.id}` });
        return "/acme/finalize";
      }
      if ((m = path.match(/^\/acme\/cert\/([\w-]+)$/))) {
        const o = ownOrder(m[1]!, acct.id);
        if (!o.cert) throw new AcmeError(404, "malformed", "No certificate for this order yet.");
        send(res, 200, o.cert, base);
        return "/acme/cert";
      }
      throw new AcmeError(404, "malformed", "No such ACME resource.");
    } catch (err) {
      if (!(err instanceof AcmeError)) throw err;
      const text = JSON.stringify({ type: `urn:ietf:params:acme:error:${err.type}`, detail: err.message, status: err.status });
      res.writeHead(err.status, {
        "content-type": "application/problem+json",
        "content-length": Buffer.byteLength(text),
        "replay-nonce": newNonce(),
        "cache-control": "no-store",
        link: `<${base}/acme/directory>;rel="index"`,
      });
      res.end(text);
      return "/acme/*";
    }
  }

  return { handle };
}
