import {
  AppShell,
  BrandProvider,
  Button,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  useLocalePreference,
  usePath,
  type ProductId,
  useThemePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { Activity, KeyRound, LogIn, LogOut, Network, Server as ServerIcon, UserRound, Users, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Person, type ProductLink, type Session } from "./api.ts";
import { AccessPage } from "./access.tsx";
import { useT } from "./i18n.ts";
import { PeoplePage, PersonPage } from "./people.tsx";
import { ServersPage } from "./servers.tsx";
import { SessionsPage } from "./sessions.tsx";
import { useApi, useData } from "./shared.tsx";

export const PAGES = ["people", "access", "sessions", "servers", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "person"; id: string };

function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "people" && id) return { page: "person", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "people" };
}

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can, signOut } = useAuth();
  const call = useApi();
  const [version, setVersion] = useState<string>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const route = parseRoute(usePath());
  const people = useData<{ people: Person[] }>(call, "/api/v1/people", 30_000);
  const sessions = useData<{ sessions: Session[] }>(call, "/api/v1/sessions", 15_000);

  useEffect(() => {
    void api<{ version: string }>("/api/v1/version").then((v) => setVersion(v.version));
  }, []);
  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "vpn" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const nav = [
    { id: "people", label: t("nav.people"), icon: UsersRound, count: people.data?.people.length || undefined },
    { id: "access", label: t("nav.access"), icon: Network },
    { id: "sessions", label: t("nav.sessions"), icon: Activity, count: sessions.data?.sessions.length || undefined },
    { id: "servers", label: t("nav.servers"), icon: ServerIcon },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: t("nav.members"), icon: Users },
          { id: "signin", label: t("nav.signin"), icon: LogIn },
          { id: "tokens", label: t("nav.tokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("nav.account"), icon: UserRound },
  ];
  const page = route.page;
  const settings = page === "account" || page === "members" || page === "signin" || page === "tokens" ? page : undefined;

  return (
    <AppShell
      product="vpn"
      nav={nav}
      activeNav={page === "person" ? "people" : page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: t(`role.${me.user.role}`) }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
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
        <EmptyState title={t("settings.adminsOnly")}>{t("settings.askAdmin")}</EmptyState>
      ) : (
        <>
          <PageHeader
            title={t(`nav.${settings}`)}
            description={t(`settings.${settings}`)}
            actions={
              settings === "account" && (
                <Button icon={<LogOut />} onClick={() => void signOut()}>
                  {t("settings.signOut")}
                </Button>
              )
            }
          />
          {settings === "account" ? (
            <AccountSettings />
          ) : settings === "members" ? (
            <MembersSettings />
          ) : settings === "signin" ? (
            <SignInSettings />
          ) : (
            <TokensSettings />
          )}
        </>
      )}
    </AppShell>
  );
}

export function App() {
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy VPN">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
