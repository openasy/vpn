// The VPN's certificate authority: issues server and device certificates and the revocation list.
// Keys are ECDSA P-256, generated with the runtime's WebCrypto.
import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
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

// ---- the internal CA (ADR 0054) ----------------------------------------------------------------------------------

/** DER length and TLV, enough for the Name Constraints extension, which @peculiar/x509 has no class for. */
const derLength = (n: number) =>
  n < 128
    ? Buffer.from([n])
    : Buffer.concat([
        Buffer.from([0x80 | Math.ceil(n.toString(16).length / 2)]),
        Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0"), "hex"),
      ]);
const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};

/**
 * Name Constraints (RFC 5280 4.2.1.10): names under `domain` only, and no IP address at all. A device that trusts the
 * root trusts it for those names alone, so the CA's key cannot impersonate any other site.
 */
export function nameConstraints(domain: string): x509.Extension {
  const subtree = (generalName: Buffer) => tlv(0x30, generalName);
  const permitted = tlv(0xa0, subtree(tlv(0x82, Buffer.from(domain, "ascii"))));
  // iPAddress [7] with a zero address and mask: every IPv4 and every IPv6 address.
  const excluded = tlv(0xa1, subtree(tlv(0x87, Buffer.alloc(8))), subtree(tlv(0x87, Buffer.alloc(32))));
  return new x509.Extension("2.5.29.30", true, tlv(0x30, permitted, excluded));
}

/** A root for the install's internal domain: ten years, no intermediate below it, and constrained to the domain. */
export async function createInternalCa(domain: string): Promise<Ca> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: newSerial(),
    name: `CN=OpenAsy internal CA for ${domain}, O=OpenAsy`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 365 * DAY),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      nameConstraints(domain),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { cert: cert.toString("pem"), key: await pkcs8(keys.privateKey) };
}

/** A server certificate for names under the domain, for a public key from anywhere: a new one here, or a CSR's. */
export async function issueFor(
  ca: Ca,
  publicKey: CryptoKey | x509.PublicKey,
  names: string[],
  days: number,
): Promise<{ serial: string; cert: string; notAfter: string }> {
  const caCert = new x509.X509Certificate(ca.cert);
  const serial = newSerial();
  const notAfter = new Date(Date.now() + days * DAY);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    subject: `CN=${names[0]}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter,
    signingKey: await importKey(ca.key),
    publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(
        names.map((value) => ({ type: "dns" as const, value })),
        false,
      ),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
      await x509.SubjectKeyIdentifierExtension.create(publicKey),
    ],
  });
  return { serial, cert: cert.toString("pem"), notAfter: notAfter.toISOString() };
}

/** A server certificate with a new key that is returned once and never kept. */
export async function issueServer(ca: Ca, names: string[], days: number): Promise<Issued & { names: string[] }> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const issued = await issueFor(ca, keys.publicKey, names, days);
  return { ...issued, names, key: await pkcs8(keys.privateKey) };
}

/**
 * A CSR's public key and DNS names, once its signature is checked; undefined for anything else. ACME clients send
 * one at finalize (RFC 8555 7.4).
 */
export async function readCsr(der: Uint8Array): Promise<{ publicKey: x509.PublicKey; names: string[] } | undefined> {
  try {
    const csr = new x509.Pkcs10CertificateRequest(Uint8Array.from(der));
    if (!(await csr.verify())) return undefined;
    const san = csr.extensions.find((e) => e.type === "2.5.29.17");
    const names = san
      ? new x509.SubjectAlternativeNameExtension(san.rawData).names.items.filter((n) => n.type === "dns").map((n) => n.value.toLowerCase())
      : [];
    const cn = /CN=([^,+]+)/.exec(csr.subject)?.[1]?.toLowerCase();
    return { publicKey: csr.publicKey, names: [...new Set([...(cn && !names.length ? [cn] : []), ...names])] };
  } catch {
    return undefined;
  }
}

/** The root as DER, the form Windows opens as a .cer file. */
export const toDer = (pem: string) => Buffer.from(x509.PemConverter.decodeFirst(pem));

/**
 * An Apple configuration profile that installs the root on macOS, iOS and iPadOS. Its ids come from the root, so the
 * same root always gives the same profile and installing it again replaces it. The person still turns on full trust
 * for it, under Settings, General, About, Certificate Trust Settings on iOS.
 */
export function mobileconfig(pem: string, domain: string): string {
  const der = toDer(pem);
  const hash = createHash("sha256").update(der).digest("hex");
  const uuid = (salt: string) => {
    const h = createHash("sha256")
      .update(salt + hash)
      .digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
  };
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const name = esc(`OpenAsy internal CA for ${domain}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>openasy-internal-ca.cer</string>
      <key>PayloadContent</key>
      <data>${der.toString("base64")}</data>
      <key>PayloadDisplayName</key>
      <string>${name}</string>
      <key>PayloadIdentifier</key>
      <string>io.github.openasy.internal-ca.${hash.slice(0, 16)}.root</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuid("root")}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>${esc(`Trusts certificates for names under ${domain}, and nothing else.`)}</string>
  <key>PayloadDisplayName</key>
  <string>${name}</string>
  <key>PayloadIdentifier</key>
  <string>io.github.openasy.internal-ca.${hash.slice(0, 16)}</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid("profile")}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
