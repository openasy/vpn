import { AppShell, BrandProvider, Button, Callout, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, TextField } from "@openasy/ui";
import { useEffect, useState, type FormEvent } from "react";

interface Server {
  id: string;
  version: string;
  listen: string | null;
  openvpnRunning: boolean;
  configVersion: string | null;
  lastSeen: string;
}

// Until sign-in exists (ADR 0002), the UI uses VPN_ADMIN_TOKEN, kept only for this browser tab.
const TOKEN_KEY = "vpn-admin-token";
const readToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};

class Unauthorized extends Error {}

// The UI is an ordinary client of the public API (ADR 0014, 0018).
async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status === 401 || res.status === 503) throw new Unauthorized(((await res.json()) as { detail?: string }).detail);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

function TokenForm({ error, onToken }: { error?: string; onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onToken(value.trim());
  };
  return (
    <Panel title="Admin token">
      <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
        <p className="m-0 text-sm text-fg-muted">Sign-in is not built yet. Paste the VPN_ADMIN_TOKEN set on vpn-manager; it is kept only in this tab.</p>
        <TextField label="VPN_ADMIN_TOKEN" type="password" autoComplete="off" mono value={value} onChange={(e) => setValue(e.target.value)} error={error} />
        <div>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            Continue
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function App() {
  const [version, setVersion] = useState<string>();
  const [token, setToken] = useState(readToken);
  const [authError, setAuthError] = useState<string>();
  const [servers, setServers] = useState<Server[]>([]);

  useEffect(() => {
    get<{ version: string }>("/api/v1/version", "").then((v) => setVersion(v.version));
  }, []);

  useEffect(() => {
    if (!token) return;
    const load = () =>
      get<{ servers: Server[] }>("/api/v1/servers", token).then(
        (r) => {
          setServers(r.servers);
          setAuthError(undefined);
        },
        (err: Error) => {
          if (err instanceof Unauthorized) {
            setAuthError(err.message);
            setToken("");
          }
        },
      );
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [token]);

  const saveToken = (t: string) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      // Storage blocked: the token lasts until the page reloads.
    }
    setToken(t);
  };

  const running = servers.filter((s) => s.openvpnRunning).length;

  return (
    <BrandProvider>
      <AppShell product="vpn" nav={[{ id: "servers", label: "Servers" }]} activeNav="servers">
        <PageHeader title="Servers" description={version ? `vpn-manager ${version}` : undefined} />
        <Callout tone="warning" title="For testing only">
          This release has no sign-in and keeps the CA key unencrypted. Manage people and devices through the API at <a href="/api/docs/">/api/docs/</a>.
        </Callout>
        {!token ? (
          <TokenForm error={authError} onToken={saveToken} />
        ) : (
          <>
            <KpiGrid>
              <KpiCard label="Servers" value={servers.length} />
              <KpiCard label="OpenVPN running" value={running} tone={running < servers.length ? "warning" : "success"} />
            </KpiGrid>
            <Panel title="Connected servers">
              {servers.length === 0 ? (
                <EmptyState title="No servers yet">Start vpn-server with VPN_MANAGER_URL and VPN_SERVER_TOKEN pointing here.</EmptyState>
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
        )}
      </AppShell>
    </BrandProvider>
  );
}
