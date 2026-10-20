import { AppShell, BrandProvider, Button, EmptyState, PageHeader } from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { Activity, KeyRound, LogOut, Network, Server as ServerIcon, UserRound, Users, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Person, type Session } from "./api.ts";
import { AccessPage } from "./access.tsx";
import { PeoplePage, PersonPage } from "./people.tsx";
import { ServersPage } from "./servers.tsx";
import { SessionsPage } from "./sessions.tsx";
import { useApi, useData } from "./shared.tsx";

const PAGES = ["people", "access", "sessions", "servers", "account", "members", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "person"; id: string };

function parseRoute(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, "").split("/");
  if (page === "people" && id) return { page: "person", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "people" };
}

const SETTINGS = {
  account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
  members: ["Members", "Who can sign in to this VPN, and with which role. Viewers see everything; editors also add people and devices and end sessions; admins also remove people and manage groups, IP groups, members and tokens."],
  tokens: ["API tokens", "For scripts and the command line tool. Each token has one role and an expiry; the secret is shown once."],
} as const;

function Product() {
  const { me, can, signOut } = useAuth();
  const call = useApi();
  const [version, setVersion] = useState<string>();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const people = useData<{ people: Person[] }>(call, "/api/v1/people", 30_000);
  const sessions = useData<{ sessions: Session[] }>(call, "/api/v1/sessions", 15_000);

  useEffect(() => {
    void api<{ version: string }>("/api/v1/version").then((v) => setVersion(v.version));
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const nav = [
    { id: "people", label: "People", icon: UsersRound, count: people.data?.people.length || undefined },
    { id: "access", label: "Access", icon: Network },
    { id: "sessions", label: "Sessions", icon: Activity, count: sessions.data?.sessions.length || undefined },
    { id: "servers", label: "Servers", icon: ServerIcon },
  ];
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
  const page = route.page;
  const settings = page === "account" || page === "members" || page === "tokens" ? page : undefined;

  return (
    <AppShell
      product="vpn"
      nav={nav}
      activeNav={page === "person" ? "people" : page}
      onNavigate={(id) => (window.location.hash = `#/${id}`)}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
    >
      {route.page === "person" ? (
        <PersonPage key={route.id} call={call} id={route.id} />
      ) : page === "people" ? (
        <PeoplePage call={call} />
      ) : page === "access" ? (
        <AccessPage call={call} />
      ) : page === "sessions" ? (
        <SessionsPage call={call} />
      ) : page === "servers" ? (
        <ServersPage call={call} version={version} />
      ) : !settings ? null : settings !== "account" && !can("admin") ? (
        <EmptyState title="Admins only">Ask an admin of this VPN for access.</EmptyState>
      ) : (
        <>
          <PageHeader
            title={SETTINGS[settings][0]}
            description={SETTINGS[settings][1]}
            actions={
              settings === "account" && (
                <Button icon={<LogOut />} onClick={() => void signOut()}>
                  Sign out
                </Button>
              )
            }
          />
          {settings === "account" ? <AccountSettings /> : settings === "members" ? <MembersSettings /> : <TokensSettings />}
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
