import "reflect-metadata";
import { createHash, createHmac, X509Certificate, type webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** A small ACME client, as Caddy or certbot does it: one account key, JWS requests with nonces (RFC 8555). */
async function client(base: string, alg: "ES256" | "RS256" = "ES256") {
  const params =
    alg === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const full = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as webcrypto.JsonWebKey;
  const jwk = alg === "ES256" ? { crv: full.crv, kty: full.kty, x: full.x, y: full.y } : { e: full.e, kty: full.kty, n: full.n };
  const thumb = b64u(createHash("sha256").update(JSON.stringify(jwk)).digest());
  const dir = (await (await fetch(`${base}/acme/directory`)).json()) as Record<string, string>;
  let nonce = (await fetch(dir.newNonce!, { method: "HEAD" })).headers.get("replay-nonce")!;
  let kid: string | undefined;
  const sign = async (protectedHeader: Record<string, unknown>, payload: string) => {
    const data = `${b64u(JSON.stringify(protectedHeader))}.${payload}`;
    const sig = await crypto.subtle.sign(
      alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(data),
    );
    return { protected: data.split(".")[0], payload, signature: b64u(new Uint8Array(sig)) };
  };
  const post = async (url: string, payload: unknown, extra: Record<string, unknown> = {}) => {
    const header = { alg, nonce, url, ...(kid ? { kid } : { jwk }), ...extra };
    const body = await sign(header, payload === "" ? "" : b64u(JSON.stringify(payload)));
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/jose+json" }, body: JSON.stringify(body) });
    nonce = res.headers.get("replay-nonce") ?? nonce;
    const type = res.headers.get("content-type") ?? "";
    return { res, body: type.includes("json") ? ((await res.json()) as any) : await res.text() };
  };
  /** The account key signed with an EAB key an admin made, as the client puts it in new-account. */
  const eab = (keyId: string, hmacKey: string, url = dir.newAccount!) => {
    const prot = b64u(JSON.stringify({ alg: "HS256", kid: keyId, url }));
    const payload = b64u(JSON.stringify(jwk));
    return { protected: prot, payload, signature: b64u(createHmac("sha256", Buffer.from(hmacKey, "base64url")).update(`${prot}.${payload}`).digest()) };
  };
  const register = async (keyId: string, hmacKey: string) => {
    const r = await post(dir.newAccount!, { termsOfServiceAgreed: true, externalAccountBinding: eab(keyId, hmacKey) });
    if (r.res.status === 201 || r.res.status === 200) kid = r.res.headers.get("location")!;
    return r;
  };
  const csr = async (names: string[]) => {
    const certKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const req = await x509.Pkcs10CertificateRequestGenerator.create({
      name: `CN=${names[0]}`,
      keys: certKeys,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      extensions: [new x509.SubjectAlternativeNameExtension(names.map((value) => ({ type: "dns" as const, value })))],
    });
    return b64u(new Uint8Array(req.rawData));
  };
  return { dir, post, register, eab, csr, thumb, setNonce: (n: string) => (nonce = n) };
}

let app: Awaited<ReturnType<typeof startApp>>;
let web: Server;
/** What the web host serves at /.well-known/acme-challenge/<token>, as Caddy does during http-01. */
const served = new Map<string, string>();

beforeAll(async () => {
  web = createServer((req, res) => {
    const token = req.url?.split("/").pop() ?? "";
    const body = served.get(`${req.headers.host}/${token}`);
    res.writeHead(body ? 200 : 404).end(body ?? "");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  app = await startApp({ version: "1.2.3", dnsDomain: "internal.yr", acmeHttpPort: (web.address() as AddressInfo).port });
  app.vpn.createInternalName({ name: "web", type: "A", value: "127.0.0.1" });
  app.vpn.createInternalName({ name: "logs", type: "CNAME", value: "web.internal.yr" });
});
afterAll(async () => {
  await app.close();
  await new Promise((r) => web.close(r));
});

describe("ACME for the internal CA (ADR 0054)", () => {
  it("issues a certificate for names it proved with http-01, to an account bound with an admin's key", async () => {
    const c = await client(app.base);
    expect(c.dir).toMatchObject({ newAccount: `${app.base}/acme/new-account`, meta: { externalAccountRequired: true } });

    // Without a binding, or with a wrong one, there is no account.
    const bare = await c.post(c.dir.newAccount!, { termsOfServiceAgreed: true });
    expect(bare.res.status).toBe(401);
    expect(bare.body.type).toBe("urn:ietf:params:acme:error:externalAccountRequired");
    const key = app.vpn.createAcmeKey({ name: "Caddy on web" });
    expect((await c.register(key.id, Buffer.alloc(32, 1).toString("base64url"))).res.status).toBe(401);

    const account = await c.register(key.id, key.hmacKey);
    expect(account.res.status).toBe(201);
    expect(account.body.status).toBe("valid");

    const order = await c.post(c.dir.newOrder!, {
      identifiers: [
        { type: "dns", value: "web.internal.yr" },
        { type: "dns", value: "logs.internal.yr" },
      ],
    });
    expect(order.res.status).toBe(201);
    expect(order.body).toMatchObject({ status: "pending", authorizations: [expect.any(String), expect.any(String)] });

    // Each name is proved at the address its internal record gives, the alias through its target.
    for (const url of order.body.authorizations as string[]) {
      const authz = (await c.post(url, "")).body;
      const ch = authz.challenges[0];
      expect(ch.type).toBe("http-01");
      served.set(`${authz.identifier.value}/${ch.token}`, `${ch.token}.${c.thumb}`);
      expect((await c.post(ch.url, {})).body.status).toBe("valid");
    }
    const orderUrl = order.res.headers.get("location")!;
    expect((await c.post(orderUrl, "")).body.status).toBe("ready");

    const final = await c.post(order.body.finalize, { csr: await c.csr(["web.internal.yr", "logs.internal.yr"]) });
    expect(final.res.status).toBe(200);
    expect(final.body.status).toBe("valid");
    const chain = (await c.post(final.body.certificate, "")).body as string;
    const [leafPem, rootPem] = chain.split(/(?<=-----END CERTIFICATE-----\n)/);
    const leaf = new X509Certificate(leafPem!);
    expect(leaf.verify(new X509Certificate(rootPem!).publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe("DNS:web.internal.yr, DNS:logs.internal.yr");
    expect(new X509Certificate(rootPem!).fingerprint256).toBe(app.vpn.internalCa().root!.fingerprint);
    expect(app.vpn.listAcmeKeys()[0]!.lastUsedAt).not.toBeNull();
  });

  it("refuses wildcards, names outside the domain, a used nonce, a wrong answer and a CSR for other names", async () => {
    const c = await client(app.base, "RS256");
    const key = app.vpn.createAcmeKey({ name: "certbot" });
    expect((await c.register(key.id, key.hmacKey)).res.status).toBe(201);

    const wildcard = await c.post(c.dir.newOrder!, { identifiers: [{ type: "dns", value: "*.internal.yr" }] });
    expect(wildcard.body.type).toBe("urn:ietf:params:acme:error:rejectedIdentifier");
    const outside = await c.post(c.dir.newOrder!, { identifiers: [{ type: "dns", value: "www.example.com" }] });
    expect(outside.body.type).toBe("urn:ietf:params:acme:error:rejectedIdentifier");
    c.setNonce("used-or-made-up");
    expect((await c.post(c.dir.newOrder!, { identifiers: [{ type: "dns", value: "web.internal.yr" }] })).body.type).toBe("urn:ietf:params:acme:error:badNonce");

    // The host answers something else: the name is not proved, and the order cannot be finalized.
    const order = await c.post(c.dir.newOrder!, { identifiers: [{ type: "dns", value: "web.internal.yr" }] });
    const authz = (await c.post(order.body.authorizations[0], "")).body;
    served.set(`web.internal.yr/${authz.challenges[0].token}`, "not the key authorization");
    expect((await c.post(authz.challenges[0].url, {})).body.status).toBe("invalid");
    expect((await c.post(order.body.finalize, { csr: await c.csr(["web.internal.yr"]) })).body.type).toBe("urn:ietf:params:acme:error:orderNotReady");

    // A CSR that names more than the order is refused.
    const second = await c.post(c.dir.newOrder!, { identifiers: [{ type: "dns", value: "web.internal.yr" }] });
    const a2 = (await c.post(second.body.authorizations[0], "")).body;
    served.set(`web.internal.yr/${a2.challenges[0].token}`, `${a2.challenges[0].token}.${c.thumb}`);
    await c.post(a2.challenges[0].url, {});
    const bad = await c.post(second.body.finalize, { csr: await c.csr(["web.internal.yr", "admin.internal.yr"]) });
    expect(bad.body.type).toBe("urn:ietf:params:acme:error:badCSR");

    // Another account sees none of it.
    const other = await client(app.base);
    const k2 = app.vpn.createAcmeKey({ name: "other" });
    await other.register(k2.id, k2.hmacKey);
    expect((await other.post(second.res.headers.get("location")!, "")).res.status).toBe(404);
  });

  it("closes the accounts of a removed key", async () => {
    const c = await client(app.base);
    const key = app.vpn.createAcmeKey({ name: "temporary" });
    await c.register(key.id, key.hmacKey);
    app.vpn.deleteAcmeKey(key.id);
    const r = await c.post(c.dir.newOrder!, { identifiers: [{ type: "dns", value: "web.internal.yr" }] });
    expect(r.res.status).toBe(401);
  });
});
