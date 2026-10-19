// IPv4 helpers for the VPN network and IP groups. IPv6 comes later.

export interface Cidr {
  network: number;
  prefix: number;
}

export function parseIp(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
    n = n * 256 + Number(p);
  }
  return n;
}

export const formatIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** "10.8.0.0/24" with the host bits zero, or undefined. */
export function parseCidr(value: string): Cidr | undefined {
  const [ip, bits] = value.split("/");
  const network = ip === undefined ? undefined : parseIp(ip);
  const prefix = Number(bits);
  if (network === undefined || !/^\d{1,2}$/.test(bits ?? "") || prefix > 32) return undefined;
  if ((network & ~maskOf(prefix)) >>> 0 !== 0) return undefined;
  return { network, prefix };
}

export const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
export const formatMask = (prefix: number) => formatIp(maskOf(prefix));
export const formatCidr = (c: Cidr) => `${formatIp(c.network)}/${c.prefix}`;

/** Host addresses for clients: skips the network, the server (.1) and the broadcast address. */
export function clientAddresses(c: Cidr): { first: number; last: number } {
  const size = 2 ** (32 - c.prefix);
  return { first: c.network + 2, last: c.network + size - 2 };
}

/** "tcp/5432, 6432", "udp/53", "any". Returns undefined when malformed. */
export function parsePorts(value: string): Array<{ proto: "tcp" | "udp" | "any"; ports: number[] }> | undefined {
  const v = value.trim().toLowerCase();
  if (v === "any" || v === "") return [{ proto: "any", ports: [] }];
  const m = v.match(/^(tcp|udp)\/(.+)$/);
  if (!m) return undefined;
  const ports = m[2]!.split(",").map((p) => Number(p.trim()));
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) return undefined;
  return [{ proto: m[1] as "tcp" | "udp", ports }];
}
