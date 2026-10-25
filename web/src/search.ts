// What the search window (Cmd+K) finds in VPN: people by name or email, and servers by address. They are read whole
// and filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Server as ServerIcon, UserRound } from "lucide-react";
import type { Person, Server } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [people, servers] = await Promise.all([
      call<{ people: Person[] }>("/api/v1/people", { signal }),
      call<{ servers: Server[] }>("/api/v1/servers", { signal }),
    ]);
    const has = (...texts: Array<string | null>) => texts.some((x) => x?.toLowerCase().includes(q));
    return [
      ...people.people
        .filter((p) => has(p.name, p.email))
        .slice(0, 6)
        .map((p): SearchResult => ({
          id: `person:${p.id}`,
          label: p.name,
          detail: t("search.personDetail", { email: p.email, devices: p.devices }),
          kind: t("search.person"),
          icon: UserRound,
          href: `/people/${encodeURIComponent(p.id)}`,
        })),
      ...servers.servers
        .filter((s) => has(s.id, s.address))
        .slice(0, 6)
        .map((s): SearchResult => ({
          id: `server:${s.id}`,
          label: s.address ?? s.id,
          detail: s.status,
          kind: t("search.server"),
          icon: ServerIcon,
          mono: true,
          href: "/servers",
        })),
    ];
  };
}
