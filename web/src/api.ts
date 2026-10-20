// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json and server/vpn.ts.
import type { Device, Group, IpGroup, IpNetwork, Person, Session } from "../../server/vpn.ts";

export type { Device, Group, IpGroup, IpNetwork, Person, Session };

export interface Server {
  id: string;
  version: string;
  listen: string | null;
  openvpnRunning: boolean;
  configVersion: string | null;
  lastSeen: string;
}

export class Unauthorized extends Error {}
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
