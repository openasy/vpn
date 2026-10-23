import { Badge, Button, Callout, Checkbox, Dialog, PageHeader, Panel, SelectField, Switch, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Download, FileBadge, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Group, InternalCa, InternalCertificate, InternalName, IpGroup, IpNetwork } from "./api.ts";
import { useT } from "./i18n.ts";
import { Code, date, download, List, Problem, useAction, useData, type Call } from "./shared.tsx";

export function AccessPage({ call }: { call: Call }) {
  const t = useT();
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const ipGroups = useData<{ ipGroups: IpGroup[] }>(call, "/api/v1/ip-groups", 0);
  const names = useData<{ domain: string | null; forward: boolean; names: InternalName[] }>(call, "/api/v1/internal-names", 0);
  const reload = () => (groups.reload(), ipGroups.reload());
  const domain = names.data?.domain ?? null;
  return (
    <>
      <PageHeader title={t("access.title")} description={t("access.description")} />
      <IpGroups call={call} ipGroups={ipGroups.data?.ipGroups} groups={groups.data?.groups ?? []} domain={domain} onChange={reload} />
      <Groups call={call} groups={groups.data?.groups} onChange={reload} />
      {names.data && <InternalNames call={call} domain={domain} forward={names.data.forward} names={names.data.names} onChange={names.reload} />}
      {domain && <InternalCaPanel call={call} />}
    </>
  );
}

function Groups({ call, groups, onChange }: { call: Call; groups: Group[] | undefined; onChange: () => void }) {
  const { can } = useAuth();
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const action = useAction();
  const close = () => (setAdding(false), setName(""), action.clear());
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => call("/api/v1/groups", { method: "POST", body: JSON.stringify({ name }) }))) (close(), onChange());
  };
  const columns: Column<Group>[] = [
    { id: "name", header: t("access.group"), cell: (g) => g.name, sortValue: (g) => g.name },
    { id: "people", header: t("access.people"), width: "90px", align: "right", mono: true, cell: (g) => g.people, sortValue: (g) => g.people },
    ...(can("admin")
      ? [
          {
            id: "remove",
            header: "",
            width: "100px",
            cell: (g: Group) => (
              <Button
                size="xs"
                variant="ghost"
                icon={<Trash2 />}
                onClick={() =>
                  window.confirm(t("access.confirmRemoveGroup", { name: g.name, count: g.people })) &&
                  void action.run(() => call(`/api/v1/groups/${g.id}`, { method: "DELETE" })).then(onChange)
                }
              >
                {t("common.remove")}
              </Button>
            ),
          } satisfies Column<Group>,
        ]
      : []),
  ];
  return (
    <Panel
      title={t("common.groups")}
      description={t("access.groupsBody")}
      actions={
        can("admin") && (
          <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
            {t("access.addGroup")}
          </Button>
        )
      }
      flush
    >
      {!adding && <Problem error={action.error} />}
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={t("access.addGroupTitle")}
        description={t("access.addGroupBody")}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={action.busy} disabled={!name}>
              {t("access.addGroup")}
            </Button>
          </>
        }
      >
        <Problem error={action.error} title={t("common.notAdded")} />
        <TextField label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("access.groupPlaceholder")} />
      </Dialog>
      <List label={t("common.groups")} rows={groups} columns={columns} empty={t("access.noGroups")} getRowId={(g) => g.id} />
    </Panel>
  );
}

/** Names every server answers to devices on the VPN, under the install's domain (ADR 0054). */
function InternalNames({
  call,
  domain,
  forward,
  names,
  onChange,
}: {
  call: Call;
  domain: string | null;
  forward: boolean;
  names: InternalName[];
  onChange: () => void;
}) {
  const { can } = useAuth();
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<InternalName["type"]>("A");
  const [value, setValue] = useState("");
  const action = useAction();
  const close = () => (setAdding(false), setName(""), setType("A"), setValue(""), action.clear());
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => call("/api/v1/internal-names", { method: "POST", body: JSON.stringify({ name, type, value }) }))) (close(), onChange());
  };
  if (!domain)
    return (
      <Panel title={t("access.internalNames")}>
        <Callout tone="info" title={t("access.internalNamesOff")}>
          {t("access.internalNamesOffBody")}
        </Callout>
      </Panel>
    );
  const columns: Column<InternalName>[] = [
    { id: "name", header: t("access.name"), mono: true, cell: (n) => n.fqdn, sortValue: (n) => n.fqdn },
    { id: "type", header: t("access.type"), width: "90px", cell: (n) => <Badge>{n.type}</Badge>, sortValue: (n) => n.type },
    { id: "value", header: t("access.value"), mono: true, cell: (n) => n.value, sortValue: (n) => n.value },
    ...(can("admin")
      ? [
          {
            id: "remove",
            header: "",
            width: "100px",
            cell: (n: InternalName) => (
              <Button
                size="xs"
                variant="ghost"
                icon={<Trash2 />}
                onClick={() =>
                  window.confirm(t("access.confirmRemoveName", { name: n.fqdn })) &&
                  void action.run(() => call(`/api/v1/internal-names/${n.id}`, { method: "DELETE" })).then(onChange)
                }
              >
                {t("common.remove")}
              </Button>
            ),
          } satisfies Column<InternalName>,
        ]
      : []),
  ];
  return (
    <Panel
      title={t("access.internalNames")}
      description={t(forward ? "access.internalNamesSplit" : "access.internalNamesBody", { domain })}
      actions={
        can("admin") && (
          <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
            {t("access.addName")}
          </Button>
        )
      }
      flush
    >
      {!adding && <Problem error={action.error} />}
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={t("access.addNameTitle")}
        description={t("access.addNameBody", { domain })}
        onSubmit={add}
        footer={
          <>
            <Button type="button" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={action.busy} disabled={!name || !value}>
              {t("access.addName")}
            </Button>
          </>
        }
      >
        <Problem error={action.error} title={t("common.notAdded")} />
        <TextField label={t("access.name")} mono value={name} onChange={(e) => setName(e.target.value)} placeholder={t("access.namePlaceholder")} />
        <SelectField
          label={t("access.type")}
          value={type}
          onChange={(e) => setType(e.target.value as InternalName["type"])}
          options={["A", "AAAA", "CNAME"].map((v) => ({ value: v, label: v }))}
        />
        <TextField
          label={t("access.value")}
          mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={type === "CNAME" ? `web.${domain}` : type === "AAAA" ? "fd00::5" : t("access.valuePlaceholder")}
        />
      </Dialog>
      <List label={t("access.internalNames")} rows={names} columns={columns} empty={t("access.noNames")} getRowId={(n) => n.id} />
    </Panel>
  );
}

/** The internal CA (ADR 0054): its root to install on devices, and certificates for web servers inside. */
function InternalCaPanel({ call }: { call: Call }) {
  const { can } = useAuth();
  const t = useT();
  const ca = useData<InternalCa>(call, "/api/v1/internal-ca", 0);
  const [issuing, setIssuing] = useState(false);
  const [names, setNames] = useState("");
  const [days, setDays] = useState("90");
  const [issued, setIssued] = useState<{ names: string[]; chain: string; key: string }>();
  const action = useAction();
  const close = () => (setIssuing(false), setNames(""), setDays("90"), setIssued(undefined), action.clear());
  const domain = ca.data?.domain ?? "";
  const root = ca.data?.root;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const list = names.split(/[\s,]+/).filter(Boolean);
      setIssued(await call(`/api/v1/internal-ca/certificates`, { method: "POST", body: JSON.stringify({ names: list, days: Number(days) }) }));
      ca.reload();
    });
  };
  const file = (name: string) => name.replace(/^\*\./, "wildcard.");
  const columns: Column<InternalCertificate>[] = [
    { id: "names", header: t("ca.names"), mono: true, cell: (c) => c.names.join(", "), sortValue: (c) => c.names[0] ?? "" },
    { id: "issued", header: t("ca.issued"), width: "120px", cell: (c) => date(c.createdAt), sortValue: (c) => c.createdAt },
    { id: "expires", header: t("ca.expires"), width: "120px", cell: (c) => date(c.notAfter), sortValue: (c) => c.notAfter },
  ];
  if (!root) return null;
  return (
    <Panel
      title={t("ca.internalCa")}
      description={t("ca.internalCaBody", { domain })}
      actions={
        can("admin") && (
          <Button size="sm" icon={<FileBadge />} onClick={() => setIssuing(true)}>
            {t("ca.issue")}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm">{t("ca.installRoot")}</p>
        <div className="flex flex-wrap gap-2">
          {[
            ["/api/v1/internal-ca/root.mobileconfig", t("ca.downloadApple")],
            ["/api/v1/internal-ca/root.crt?format=der", t("ca.downloadWindows")],
            ["/api/v1/internal-ca/root.crt", t("ca.downloadPem")],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium hover:border-line-strong"
            >
              <Download aria-hidden className="size-4" />
              {label}
            </a>
          ))}
        </div>
        <p className="m-0 text-xs text-fg-muted">{t("ca.installSteps")}</p>
        <dl className="m-0 grid gap-1 text-xs">
          <dt className="text-fg-muted">{t("ca.fingerprint")}</dt>
          <dd className="m-0 font-mono break-all">{root.fingerprint}</dd>
          <dd className="m-0 text-fg-muted">{t("ca.validUntil", { date: date(root.notAfter) })}</dd>
        </dl>
      </div>
      <Dialog
        open={issuing}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={issued ? t("ca.issuedTitle") : t("ca.issueTitle")}
        description={issued ? t("ca.issuedBody") : t("ca.issueBody", { domain })}
        onSubmit={issued ? undefined : submit}
        footer={
          issued ? (
            <Button type="button" variant="primary" onClick={close}>
              {t("common.done")}
            </Button>
          ) : (
            <>
              <Button type="button" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" loading={action.busy} disabled={!names.trim()}>
                {t("ca.issue")}
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <div className="flex flex-wrap gap-2">
            <Button icon={<Download />} onClick={() => download(`${file(issued.names[0]!)}.crt`, issued.chain, "application/x-pem-file")}>
              {t("ca.downloadChain")}
            </Button>
            <Button icon={<Download />} onClick={() => download(`${file(issued.names[0]!)}.key`, issued.key, "application/x-pem-file")}>
              {t("ca.downloadKey")}
            </Button>
          </div>
        ) : (
          <>
            <Problem error={action.error} title={t("common.notAdded")} />
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t("ca.names")}
              <textarea
                value={names}
                onChange={(e) => setNames(e.target.value)}
                placeholder={t("ca.namesPlaceholder", { domain })}
                rows={3}
                spellCheck={false}
                className="rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-sm font-normal"
              />
            </label>
            <TextField label={t("ca.days")} mono type="number" min={1} max={397} value={days} onChange={(e) => setDays(e.target.value)} />
          </>
        )}
      </Dialog>
      {ca.data!.certificates.length > 0 && (
        <div className="mt-4">
          <List label={t("ca.issued")} rows={ca.data!.certificates} columns={columns} empty={t("ca.noCertificates")} getRowId={(c) => c.serial} />
        </div>
      )}
      {can("admin") && <AcmeKeys call={call} domain={domain} />}
    </Panel>
  );
}

type AcmeKey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

/** Keys ACME clients bind their accounts with, so certificates inside are got and renewed by themselves (ADR 0054). */
function AcmeKeys({ call, domain }: { call: Call; domain: string }) {
  const t = useT();
  const keys = useData<{ keys: AcmeKey[] }>(call, "/api/v1/internal-ca/acme-keys", 0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ id: string; hmacKey: string; directory: string }>();
  const action = useAction();
  const close = () => (setAdding(false), setName(""), setMade(undefined), action.clear());
  const add = async (e: FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      setMade(await call("/api/v1/internal-ca/acme-keys", { method: "POST", body: JSON.stringify({ name }) }));
      keys.reload();
    });
  };
  const columns: Column<AcmeKey>[] = [
    { id: "name", header: t("ca.acmeKeyName"), cell: (k) => k.name, sortValue: (k) => k.name },
    { id: "id", header: t("ca.keyId"), mono: true, cell: (k) => k.id },
    {
      id: "used",
      header: t("ca.lastUsed"),
      width: "120px",
      cell: (k) => (k.lastUsedAt ? date(k.lastUsedAt) : t("ca.never")),
      sortValue: (k) => k.lastUsedAt ?? "",
    },
    {
      id: "remove",
      header: "",
      width: "100px",
      cell: (k) => (
        <Button
          size="xs"
          variant="ghost"
          icon={<Trash2 />}
          onClick={() =>
            window.confirm(t("ca.confirmRemoveKey", { name: k.name })) &&
            void action.run(() => call(`/api/v1/internal-ca/acme-keys/${k.id}`, { method: "DELETE" })).then(keys.reload)
          }
        >
          {t("common.remove")}
        </Button>
      ),
    },
  ];
  const caddyfile = (m: NonNullable<typeof made>) => `{\n\tacme_ca ${m.directory}\n\tacme_eab {\n\t\tkey_id ${m.id}\n\t\tmac_key ${m.hmacKey}\n\t}\n}`;
  const certbot = (m: NonNullable<typeof made>) =>
    `REQUESTS_CA_BUNDLE=openasy-internal-ca.crt certbot certonly --standalone \\\n  --server ${m.directory} \\\n  --eab-kid ${m.id} --eab-hmac-key ${m.hmacKey} \\\n  -d grafana.${domain}`;
  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-sm font-semibold">{t("ca.acmeKeys")}</h3>
          <p className="m-0 text-xs text-fg-muted">{t("ca.acmeKeysBody")}</p>
        </div>
        <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
          {t("ca.addAcmeKey")}
        </Button>
      </div>
      {!adding && <Problem error={action.error} />}
      <Dialog
        open={adding}
        onOpenChange={(open) => !open && close()}
        size={made ? "lg" : "sm"}
        title={made ? t("ca.acmeKeyMadeTitle") : t("ca.acmeKeyTitle")}
        description={made ? t("ca.acmeKeyMadeBody") : t("ca.acmeKeyBody")}
        onSubmit={made ? undefined : add}
        footer={
          made ? (
            <Button type="button" variant="primary" onClick={close}>
              {t("common.done")}
            </Button>
          ) : (
            <>
              <Button type="button" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" loading={action.busy} disabled={!name.trim()}>
                {t("ca.addAcmeKey")}
              </Button>
            </>
          )
        }
      >
        {made ? (
          <div className="flex flex-col gap-3">
            <dl className="m-0 grid gap-1 text-xs">
              <dt className="text-fg-muted">{t("ca.directory")}</dt>
              <dd className="m-0 font-mono break-all">{made.directory}</dd>
              <dt className="text-fg-muted">{t("ca.keyId")}</dt>
              <dd className="m-0 font-mono break-all">{made.id}</dd>
              <dt className="text-fg-muted">{t("ca.hmacKey")}</dt>
              <dd className="m-0 font-mono break-all">{made.hmacKey}</dd>
            </dl>
            <Code label="Caddyfile">{caddyfile(made)}</Code>
            <Code label="certbot">{certbot(made)}</Code>
          </div>
        ) : (
          <>
            <Problem error={action.error} title={t("common.notAdded")} />
            <TextField label={t("ca.acmeKeyName")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ca.acmeKeyNamePlaceholder")} />
          </>
        )}
      </Dialog>
      <List label={t("ca.acmeKeys")} rows={keys.data?.keys} columns={columns} empty={t("ca.noAcmeKeys")} getRowId={(k) => k.id} />
    </div>
  );
}

const networkText = (n: IpNetwork) => `${n.cidr}${n.ports === "any" ? "" : ` ${n.ports}`}`;

function IpGroups({
  call,
  ipGroups,
  groups,
  domain,
  onChange,
}: {
  call: Call;
  ipGroups: IpGroup[] | undefined;
  groups: Group[];
  domain: string | null;
  onChange: () => void;
}) {
  const { can } = useAuth();
  const t = useT();
  const [editing, setEditing] = useState<IpGroup | "new">();
  const action = useAction();
  const columns: Column<IpGroup>[] = [
    {
      id: "name",
      header: t("access.ipGroup"),
      cell: (g) => (
        <span className="flex flex-wrap items-center gap-1">
          {g.name}
          {g.fullTunnel && <Badge tone="info">{t("access.fullTunnel")}</Badge>}
          {domain && !g.internalNames && <Badge>{t("access.noInternalNames")}</Badge>}
        </span>
      ),
      sortValue: (g) => g.name,
    },
    {
      id: "networks",
      header: t("access.networksAndPorts"),
      cell: (g) =>
        g.networks.length ? (
          <span className="flex flex-col gap-0.5 font-mono text-xs">
            {g.networks.map((n, i) => (
              <span key={i} title={n.note || undefined}>
                {networkText(n)}
              </span>
            ))}
          </span>
        ) : (
          "–"
        ),
    },
    {
      id: "allowed",
      header: t("access.whoMayReach"),
      cell: (g) =>
        g.allowedGroups.length ? (
          <span className="flex flex-wrap gap-1">
            {g.allowedGroups.map((n) => (
              <Badge key={n}>{n}</Badge>
            ))}
          </span>
        ) : (
          t("access.nobodyYet")
        ),
    },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "170px",
            cell: (g: IpGroup) => (
              <span className="flex gap-1">
                <Button size="xs" variant="ghost" icon={<Pencil />} onClick={() => setEditing(g)}>
                  {t("common.edit")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={() =>
                    window.confirm(t("access.confirmRemoveIpGroup", { name: g.name })) &&
                    void action.run(() => call(`/api/v1/ip-groups/${g.id}`, { method: "DELETE" })).then(onChange)
                  }
                >
                  {t("common.remove")}
                </Button>
              </span>
            ),
          } satisfies Column<IpGroup>,
        ]
      : []),
  ];
  return (
    <>
      {editing && (
        <IpGroupEditor
          key={editing === "new" ? "new" : editing.id}
          call={call}
          ipGroup={editing === "new" ? undefined : editing}
          groups={groups}
          domain={domain}
          onDone={(changed) => (setEditing(undefined), changed && onChange())}
        />
      )}
      <Panel
        title={t("access.ipGroups")}
        description={t("access.ipGroupsBody")}
        actions={
          can("admin") && (
            <Button size="sm" icon={<Plus />} onClick={() => setEditing("new")}>
              {t("access.addIpGroup")}
            </Button>
          )
        }
        flush
      >
        <Problem error={action.error} />
        <List label={t("access.ipGroups")} rows={ipGroups} columns={columns} empty={t("access.noIpGroups")} getRowId={(g) => g.id} />
      </Panel>
    </>
  );
}

function IpGroupEditor({
  call,
  ipGroup,
  groups,
  domain,
  onDone,
}: {
  call: Call;
  ipGroup?: IpGroup;
  groups: Group[];
  domain: string | null;
  onDone: (changed: boolean) => void;
}) {
  const t = useT();
  const [name, setName] = useState(ipGroup?.name ?? "");
  const [fullTunnel, setFullTunnel] = useState(ipGroup?.fullTunnel ?? false);
  const [internalNames, setInternalNames] = useState(ipGroup?.internalNames ?? true);
  const [networks, setNetworks] = useState<IpNetwork[]>(ipGroup?.networks.length ? ipGroup.networks : [{ cidr: "", ports: "any", note: "" }]);
  const [allowed, setAllowed] = useState<string[]>(ipGroup?.allowedGroups ?? []);
  const action = useAction();
  const set = (i: number, patch: Partial<IpNetwork>) => setNetworks(networks.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { fullTunnel, ...(domain && { internalNames }), networks: networks.filter((n) => n.cidr.trim()), allowedGroups: allowed };
    const ok = await action.run(() =>
      ipGroup
        ? call(`/api/v1/ip-groups/${ipGroup.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : call("/api/v1/ip-groups", { method: "POST", body: JSON.stringify({ name, ...body }) }),
    );
    if (ok) onDone(true);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone(false)}
      size="lg"
      title={ipGroup ? t("access.editOne", { name: ipGroup.name }) : t("access.addIpGroupTitle")}
      description={t("access.editorBody")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={() => onDone(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={action.busy} disabled={!ipGroup && !name}>
            {ipGroup ? t("common.save") : t("access.addIpGroup")}
          </Button>
        </>
      }
    >
      <Problem error={action.error} title={t("common.notSaved")} />
      {!ipGroup && <TextField label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("access.ipGroupPlaceholder")} />}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t("access.networks")}</legend>
        {networks.map((n, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <TextField label={t("access.network")} mono value={n.cidr} onChange={(e) => set(i, { cidr: e.target.value })} placeholder="172.16.20.0/24" />
            <TextField
              label={t("access.ports")}
              mono
              value={n.ports}
              onChange={(e) => set(i, { ports: e.target.value })}
              placeholder={t("access.portsPlaceholder")}
            />
            <TextField label={t("access.note")} value={n.note} onChange={(e) => set(i, { note: e.target.value })} placeholder={t("access.notePlaceholder")} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<X />}
              aria-label={t("access.removeNetwork", { n: i + 1 })}
              onClick={() => setNetworks(networks.filter((_, j) => j !== i))}
            >
              {t("common.remove")}
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" size="sm" icon={<Plus />} onClick={() => setNetworks([...networks, { cidr: "", ports: "any", note: "" }])}>
            {t("access.addNetwork")}
          </Button>
        </div>
      </fieldset>
      <Switch checked={fullTunnel} onCheckedChange={setFullTunnel} label={t("access.fullTunnel")} description={t("access.fullTunnelBody")} />
      {domain && (
        <Switch
          checked={internalNames}
          onCheckedChange={setInternalNames}
          label={t("access.internalNames")}
          description={t("access.internalNamesSwitchBody")}
        />
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t("access.allowedGroups")}</legend>
        {groups.length ? (
          <div className="flex flex-wrap gap-3">
            {groups.map((g) => (
              <Checkbox
                key={g.id}
                label={g.name}
                checked={allowed.includes(g.name)}
                onChange={(e) => setAllowed(e.target.checked ? [...allowed, g.name] : allowed.filter((x) => x !== g.name))}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-fg-muted">{t("access.addGroupFirst")}</span>
        )}
      </fieldset>
    </Dialog>
  );
}
