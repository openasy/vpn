import { Callout, DataTable, EmptyState, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path now and every `everyMs`; `reload` loads it again at once. */
export function useData<T>(call: Call, path: string | null, everyMs = 15_000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    if (!path) return;
    call<T>(path).then(
      (d) => {
        setData(d);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [call, path]);
  useEffect(() => {
    setData(undefined);
    load();
    if (!everyMs) return;
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { data, error, reload: load };
}

/** Runs a change and reports its error; `run` resolves to true when it worked. */
export function useAction() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, clear: () => setError(undefined) };
}

export const go = (hash: string) => (window.location.hash = hash);

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const date = (iso: string) => new Date(iso).toLocaleDateString();

export function bytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Saves text as a file in the browser. */
export function download(name: string, text: string, type = "application/x-openvpn-profile") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "device";

export function Problem({ error, title = "That did not work" }: { error?: string; title?: string }) {
  if (!error) return null;
  return (
    <Callout tone="danger" title={title}>
      {error}
    </Callout>
  );
}

export function List<T>({ label, rows, columns, empty, getRowId, onRowClick }: { label: string; rows: T[] | undefined; columns: Column<T>[]; empty: string; getRowId: (r: T) => string; onRowClick?: (r: T) => void }) {
  return <DataTable label={label} columns={columns} rows={rows ?? []} loading={!rows} getRowId={getRowId} pageSize={50} density="compact" onRowClick={onRowClick} empty={<EmptyState title={empty} />} />;
}
