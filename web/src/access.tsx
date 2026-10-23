import { Badge, Button, Checkbox, Dialog, PageHeader, Panel, Switch, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Group, IpGroup, IpNetwork } from "./api.ts";
import { useT } from "./i18n.ts";
import { List, Problem, useAction, useData, type Call } from "./shared.tsx";

export function AccessPage({ call }: { call: Call }) {
  const t = useT();
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const ipGroups = useData<{ ipGroups: IpGroup[] }>(call, "/api/v1/ip-groups", 0);
  const reload = () => (groups.reload(), ipGroups.reload());
  return (
    <>
      <PageHeader title={t("access.title")} description={t("access.description")} />
      <IpGroups call={call} ipGroups={ipGroups.data?.ipGroups} groups={groups.data?.groups ?? []} onChange={reload} />
      <Groups call={call} groups={groups.data?.groups} onChange={reload} />
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

const networkText = (n: IpNetwork) => `${n.cidr}${n.ports === "any" ? "" : ` ${n.ports}`}`;

function IpGroups({ call, ipGroups, groups, onChange }: { call: Call; ipGroups: IpGroup[] | undefined; groups: Group[]; onChange: () => void }) {
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

function IpGroupEditor({ call, ipGroup, groups, onDone }: { call: Call; ipGroup?: IpGroup; groups: Group[]; onDone: (changed: boolean) => void }) {
  const t = useT();
  const [name, setName] = useState(ipGroup?.name ?? "");
  const [fullTunnel, setFullTunnel] = useState(ipGroup?.fullTunnel ?? false);
  const [networks, setNetworks] = useState<IpNetwork[]>(ipGroup?.networks.length ? ipGroup.networks : [{ cidr: "", ports: "any", note: "" }]);
  const [allowed, setAllowed] = useState<string[]>(ipGroup?.allowedGroups ?? []);
  const action = useAction();
  const set = (i: number, patch: Partial<IpNetwork>) => setNetworks(networks.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { fullTunnel, networks: networks.filter((n) => n.cidr.trim()), allowedGroups: allowed };
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
