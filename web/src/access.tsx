import { Badge, Button, Checkbox, PageHeader, Panel, Switch, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Group, IpGroup, IpNetwork } from "./api.ts";
import { List, Problem, useAction, useData, type Call } from "./shared.tsx";

export function AccessPage({ call }: { call: Call }) {
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const ipGroups = useData<{ ipGroups: IpGroup[] }>(call, "/api/v1/ip-groups", 0);
  const reload = () => (groups.reload(), ipGroups.reload());
  return (
    <>
      <PageHeader
        title="Access"
        description="People are in groups; an IP group lists networks and ports and the groups that may reach them. A device gets routes to those networks only, and the server's firewall drops everything else from it."
      />
      <IpGroups call={call} ipGroups={ipGroups.data?.ipGroups} groups={groups.data?.groups ?? []} onChange={reload} />
      <Groups call={call} groups={groups.data?.groups} onChange={reload} />
    </>
  );
}

function Groups({ call, groups, onChange }: { call: Call; groups: Group[] | undefined; onChange: () => void }) {
  const { can } = useAuth();
  const [name, setName] = useState("");
  const action = useAction();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await action.run(() => call("/api/v1/groups", { method: "POST", body: JSON.stringify({ name }) }))) (setName(""), onChange());
  };
  const columns: Column<Group>[] = [
    { id: "name", header: "Group", cell: (g) => g.name, sortValue: (g) => g.name },
    { id: "people", header: "People", width: "90px", align: "right", mono: true, cell: (g) => g.people, sortValue: (g) => g.people },
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
                onClick={() => window.confirm(`Remove the group ${g.name}? Its ${g.people} people lose the access it gave them.`) && void action.run(() => call(`/api/v1/groups/${g.id}`, { method: "DELETE" })).then(onChange)}
              >
                Remove
              </Button>
            ),
          } satisfies Column<Group>,
        ]
      : []),
  ];
  return (
    <Panel title="Groups" description="Add people to groups on their page.">
      <div className="flex flex-col gap-3">
        <Problem error={action.error} />
        {can("admin") && (
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <TextField label="New group" value={name} onChange={(e) => setName(e.target.value)} placeholder="Backend engineers" />
            <Button type="submit" icon={<Plus />} loading={action.busy} disabled={!name}>
              Add group
            </Button>
          </form>
        )}
        <List label="Groups" rows={groups} columns={columns} empty="No groups yet" getRowId={(g) => g.id} />
      </div>
    </Panel>
  );
}

const networkText = (n: IpNetwork) => `${n.cidr}${n.ports === "any" ? "" : ` ${n.ports}`}`;

function IpGroups({ call, ipGroups, groups, onChange }: { call: Call; ipGroups: IpGroup[] | undefined; groups: Group[]; onChange: () => void }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState<IpGroup | "new">();
  const action = useAction();
  const columns: Column<IpGroup>[] = [
    { id: "name", header: "IP group", cell: (g) => <span className="flex flex-wrap items-center gap-1">{g.name}{g.fullTunnel && <Badge tone="info">Full tunnel</Badge>}</span>, sortValue: (g) => g.name },
    {
      id: "networks",
      header: "Networks and ports",
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
    { id: "allowed", header: "Who may reach them", cell: (g) => (g.allowedGroups.length ? <span className="flex flex-wrap gap-1">{g.allowedGroups.map((n) => <Badge key={n}>{n}</Badge>)}</span> : "Nobody yet") },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "170px",
            cell: (g: IpGroup) => (
              <span className="flex gap-1">
                <Button size="xs" variant="ghost" icon={<Pencil />} onClick={() => setEditing(g)}>
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={() => window.confirm(`Remove the IP group ${g.name}? Devices lose the routes and firewall rules it gave them.`) && void action.run(() => call(`/api/v1/ip-groups/${g.id}`, { method: "DELETE" })).then(onChange)}
                >
                  Remove
                </Button>
              </span>
            ),
          } satisfies Column<IpGroup>,
        ]
      : []),
  ];
  return (
    <>
      {editing && <IpGroupEditor key={editing === "new" ? "new" : editing.id} call={call} ipGroup={editing === "new" ? undefined : editing} groups={groups} onDone={(changed) => (setEditing(undefined), changed && onChange())} />}
      <Panel
        title="IP groups"
        description="Servers apply a change within one heartbeat, without disconnecting anyone."
        actions={
          can("admin") &&
          !editing && (
            <Button size="sm" icon={<Plus />} onClick={() => setEditing("new")}>
              Add IP group
            </Button>
          )
        }
        flush
      >
        <Problem error={action.error} />
        <List label="IP groups" rows={ipGroups} columns={columns} empty="No IP groups yet: devices connect but reach nothing" getRowId={(g) => g.id} />
      </Panel>
    </>
  );
}

function IpGroupEditor({ call, ipGroup, groups, onDone }: { call: Call; ipGroup?: IpGroup; groups: Group[]; onDone: (changed: boolean) => void }) {
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
      ipGroup ? call(`/api/v1/ip-groups/${ipGroup.id}`, { method: "PATCH", body: JSON.stringify(body) }) : call("/api/v1/ip-groups", { method: "POST", body: JSON.stringify({ name, ...body }) }),
    );
    if (ok) onDone(true);
  };
  return (
    <Panel title={ipGroup ? `Edit ${ipGroup.name}` : "Add an IP group"}>
      <form onSubmit={submit} className="flex flex-col gap-4" style={{ maxWidth: 720 }}>
        <Problem error={action.error} title="Not saved" />
        {!ipGroup && <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production databases" />}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Networks</legend>
          {networks.map((n, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <TextField label="Network" mono value={n.cidr} onChange={(e) => set(i, { cidr: e.target.value })} placeholder="172.16.20.0/24" />
              <TextField label="Ports" mono value={n.ports} onChange={(e) => set(i, { ports: e.target.value })} placeholder="tcp/5432, udp/53 or any" />
              <TextField label="Note" value={n.note} onChange={(e) => set(i, { note: e.target.value })} placeholder="Postgres primary" />
              <Button type="button" size="sm" variant="ghost" icon={<X />} aria-label={`Remove network ${i + 1}`} onClick={() => setNetworks(networks.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" size="sm" icon={<Plus />} onClick={() => setNetworks([...networks, { cidr: "", ports: "any", note: "" }])}>
              Add network
            </Button>
          </div>
        </fieldset>
        <Switch checked={fullTunnel} onCheckedChange={setFullTunnel} label="Full tunnel" description="Send all of the device's traffic through the VPN, not only these networks. Use it where traffic must leave from the office address." />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Groups that may reach these networks</legend>
          {groups.length ? (
            <div className="flex flex-wrap gap-3">
              {groups.map((g) => (
                <Checkbox key={g.id} label={g.name} checked={allowed.includes(g.name)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, g.name] : allowed.filter((x) => x !== g.name))} />
              ))}
            </div>
          ) : (
            <span className="text-sm text-fg-muted">Add a group below first.</span>
          )}
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={action.busy} disabled={!ipGroup && !name}>
            {ipGroup ? "Save" : "Add IP group"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}
