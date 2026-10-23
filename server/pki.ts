// The VPN's certificate authority: issues server and device certificates and the revocation list.
// Keys are ECDSA P-256, generated with the runtime's WebCrypto.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const DAY = 864e5;

export interface Ca {
  cert: string;
  key: string;
}

export interface Issued {
  serial: string;
  cert: string;
  key: string;
  notAfter: string;
}

const pkcs8 = async (key: CryptoKey) => x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", key), "PRIVATE KEY");
const importKey = (pem: string) => crypto.subtle.importKey("pkcs8", x509.PemConverter.decodeFirst(pem), ALG, false, ["sign"]);
// Positive 128-bit serials, as RFC 5280 asks for unpredictable ones.
const newSerial = () => "01" + randomBytes(15).toString("hex");

export async function createCa(name = "OpenAsy VPN CA"): Promise<Ca> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: newSerial(),
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 365 * DAY),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { cert: cert.toString("pem"), key: await pkcs8(keys.privateKey) };
}

/** Issues a certificate whose common name is `cn`, for an OpenVPN server or a client device. */
export async function issue(ca: Ca, kind: "server" | "client", cn: string, days = kind === "server" ? 825 : 365): Promise<Issued> {
  const caCert = new x509.X509Certificate(ca.cert);
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const serial = newSerial();
  const notAfter = new Date(Date.now() + days * DAY);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    subject: `CN=${cn}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter,
    signingKey: await importKey(ca.key),
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement, true),
      new x509.ExtendedKeyUsageExtension([kind === "server" ? x509.ExtendedKeyUsage.serverAuth : x509.ExtendedKeyUsage.clientAuth], false),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  });
  return { serial, cert: cert.toString("pem"), key: await pkcs8(keys.privateKey), notAfter: notAfter.toISOString() };
}

/** The revocation list OpenVPN checks on every new connection (`crl-verify`). */
export async function crl(ca: Ca, revoked: Array<{ serial: string; at: string }>): Promise<string> {
  const caCert = new x509.X509Certificate(ca.cert);
  const list = await x509.X509CrlGenerator.create({
    issuer: caCert.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    nextUpdate: new Date(Date.now() + 30 * DAY),
    entries: revoked.map((r) => ({ serialNumber: r.serial, revocationDate: new Date(r.at) })),
    signingKey: await importKey(ca.key),
    signingAlgorithm: ALG,
  });
  return x509.PemConverter.encode(list.rawData, "X509 CRL");
}

/** An OpenVPN static key for tls-crypt: hides and authenticates the TLS handshake. */
export function tlsCryptKey(): string {
  const hex = randomBytes(256).toString("hex");
  const lines = hex.match(/.{32}/g)!;
  return ["-----BEGIN OpenVPN Static key V1-----", ...lines, "-----END OpenVPN Static key V1-----", ""].join("\n");
}
