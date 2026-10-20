import { AppShell, BrandProvider, Button, EmptyState, KpiCard, KpiGrid, PageHeader, Panel } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { KeyRound, LogOut, Server as ServerIcon, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Server {
  id: string;
  version: string;
  listen: string | null;
  openvpnRunning: boolean;
  configVersion: string | null;
  lastSeen: string;
}

class Unauthorized extends Error {}
class MfaSetupRequired extends Error {}

// The UI is an ordinary client of the public API (ADR 0014, 0018). The session is an HttpOnly cookie set by sign-in.
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new Error(problem.detail ?? `${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useGet() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string): Promise<T> => {
      try {
        return await get<T>(path);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}

function ServersPage({ version }: { version?: string }) {
  const call = useGet();
  const [servers, setServers] = useState<Server[]>([]);
  useEffect(() => {
    const load = () => call<{ servers: Server[] }>("/api/v1/servers").then((r) => setServers(r.servers), () => {});
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [call]);
  const running = servers.filter((s) => s.openvpnRunning).length;
  return (
    <>
      <PageHeader title="Servers" description={version ? `VPN ${version}. Manage people and devices through the API at /api/docs/.` : undefined} />
      <KpiGrid>
        <KpiCard label="Servers" value={servers.length} />
        <KpiCard label="OpenVPN running" value={running} tone={running < servers.length ? "warning" : "success"} />
      </KpiGrid>
      <Panel title="Connected servers">
        {servers.length === 0 ? (
          <EmptyState title="No servers yet">Start vpn-server with VPN_URL and VPN_SERVER_TOKEN pointing here.</EmptyState>
        ) : (
          <ul>
            {servers.map((s) => (
              <li key={s.id}>
                {s.id} · {s.listen ?? "udp/1194"} · {s.version} · {s.openvpnRunning ? "running" : "stopped"} · config {s.configVersion ?? "not applied"} · last seen{" "}
                {new Date(s.lastSeen).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

type Page = "servers" | "account" | "members" | "tokens";
const parsePage = (hash: string): Page => {
  const p = hash.replace(/^#\/?/, "");
  return p === "account" || p === "members" || p === "tokens" ? p : "servers";
};

const SETTINGS = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: ["Members", "Who can sign in to this VPN, and with which role. Viewers see everything; editors also add people and devices and end sessions; admins also remove people and manage groups, IP groups, members and tokens."],
  tokens: ["API tokens", "For scripts. Each token has one role and an expiry; the secret is shown once."],
} as const;

function Product() {
  const { me, can, signOut } = useAuth();
  const [version, setVersion] = useState<string>();
  const [page, setPage] = useState<Page>(() => parsePage(window.location.hash));

  useEffect(() => {
    void get<{ version: string }>("/api/v1/version").then((v) => setVersion(v.version));
    const onHash = () => setPage(parsePage(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="vpn"
      nav={[{ id: "servers", label: "Servers", icon: ServerIcon }]}
      activeNav={page}
      onNavigate={(id) => (window.location.hash = `#/${id}`)}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
    >
      {page === "servers" ? (
        <ServersPage version={version} />
      ) : page !== "account" && !can("admin") ? (
        <EmptyState title="Admins only">Ask an admin of this VPN for access.</EmptyState>
      ) : (
        <>
          <PageHeader
            title={SETTINGS[page][0]}
            description={SETTINGS[page][1]}
            actions={
              page === "account" && (
                <Button icon={<LogOut />} onClick={() => void signOut()}>
                  Sign out
                </Button>
              )
            }
          />
          {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : <TokensSettings />}
        </>
      )}
    </AppShell>
  );
}

export function App() {
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy VPN">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
