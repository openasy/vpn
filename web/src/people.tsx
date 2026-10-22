import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, navigate, PageHeader, Panel, StatusBadge, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Ban, Check, Download, Laptop, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Device, Group, Person } from "./api.ts";
import { SessionTable } from "./sessions.tsx";
import { ago, date, download, List, Problem, slug, useAction, useData, type Call } from "./shared.tsx";

function PersonStatus({ status }: { status: Person["status"] }) {
  return <StatusBadge tone={status === "active" ? "success" : "warning"}>{status === "active" ? "Active" : "Suspended"}</StatusBadge>;
}

/** Ticks for every group; the names are what the API takes. */
function GroupPicker({ groups, value, onChange, disabled }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  if (!groups.length) return <span className="text-sm text-fg-muted">No groups yet. Admins add them under Access.</span>;
  return (
    <div className="flex flex-wrap gap-3">
      {groups.map((g) => (
        <Checkbox key={g.id} label={g.name} checked={value.includes(g.name)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...value, g.name] : value.filter((n) => n !== g.name))} />
      ))}
    </div>
  );
}

export function PeoplePage({ call }: { call: Call }) {
  const { can } = useAuth();
  const { data, reload } = useData<{ people: Person[] }>(call, "/api/v1/people");
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const [adding, setAdding] = useState(false);
  const columns: Column<Person>[] = [
    { id: "name", header: "Name", cell: (p) => <a href={`/people/${p.id}`}>{p.name}</a>, sortValue: (p) => p.name },
    { id: "email", header: "Email", cell: (p) => p.email, sortValue: (p) => p.email },
    { id: "status", header: "Status", width: "120px", cell: (p) => <PersonStatus status={p.status} />, sortValue: (p) => p.status },
    { id: "groups", header: "Groups", cell: (p) => (p.groups.length ? <span className="flex flex-wrap gap-1">{p.groups.map((g) => <Badge key={g}>{g}</Badge>)}</span> : "–") },
    { id: "devices", header: "Devices", width: "90px", align: "right", mono: true, cell: (p) => p.devices, sortValue: (p) => p.devices },
  ];
  return (
    <>
      <PageHeader
        title="People"
        description="Everyone who may connect. Each device of a person gets its own certificate and fixed VPN address; their groups decide which networks it reaches."
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add person
            </Button>
          )
        }
      />
      {adding && <AddPerson call={call} groups={groups.data?.groups ?? []} onDone={(p) => (setAdding(false), reload(), p && navigate(`/people/${p.id}`))} />}
      {data?.people.length === 0 ? (
        <EmptyState title="Nobody yet" action={can("editor") && <Button onClick={() => setAdding(true)}>Add the first person</Button>}>
          Add a person, then a device for them, and send them the .ovpn file it gives you.
        </EmptyState>
      ) : (
        <Panel flush>
          <List label="People" rows={data?.people} columns={columns} empty="Nobody yet" getRowId={(p) => p.id} />
        </Panel>
      )}
    </>
  );
}

function AddPerson({ call, groups, onDone }: { call: Call; groups: Group[]; onDone: (p?: Person) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let created: Person | undefined;
    if (await action.run(async () => (created = await call<Person>("/api/v1/people", { method: "POST", body: JSON.stringify({ name, email, groups: chosen }) })))) onDone(created);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      title="Add a person"
      description="They get devices that may connect. Signing in to this VPN product is under Members."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={() => onDone()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={action.busy} disabled={!name || !email}>
            Add person
          </Button>
        </>
      }
    >
      <Problem error={action.error} title="Not added" />
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana Kim" />
      <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@example.com" />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Groups</legend>
        <GroupPicker groups={groups} value={chosen} onChange={setChosen} />
      </fieldset>
    </Dialog>
  );
}

export function PersonPage({ call, id }: { call: Call; id: string }) {
  const { can } = useAuth();
  const person = useData<Person>(call, `/api/v1/people/${id}`, 0);
  const devices = useData<{ devices: Device[] }>(call, `/api/v1/people/${id}/devices`, 0);
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const action = useAction();
  const [chosen, setChosen] = useState<string[]>([]);
  const p = person.data;
  useEffect(() => setChosen(p?.groups ?? []), [p]);
  if (person.error) return <EmptyState title="Not found">{person.error}</EmptyState>;
  if (!p) return null;
  const change = (body: object) => action.run(() => call<Person>(`/api/v1/people/${id}`, { method: "PATCH", body: JSON.stringify(body) })).then(() => person.reload());
  const remove = () =>
    window.confirm(`Remove ${p.name}? Their devices are revoked and disconnected, and this cannot be undone.`) &&
    void action.run(() => call(`/api/v1/people/${id}`, { method: "DELETE" })).then((ok) => ok && navigate("/people"));
  const dirty = chosen.slice().sort().join("\n") !== p.groups.slice().sort().join("\n");
  return (
    <>
      <PageHeader
        title={p.name}
        description={p.email}
        breadcrumbs={[{ label: "People", href: "/people" }, { label: p.name }]}
        meta={<PersonStatus status={p.status} />}
        actions={
          <span className="flex flex-wrap gap-2">
            {can("editor") &&
              (p.status === "active" ? (
                <Button icon={<UserX />} onClick={() => window.confirm(`Suspend ${p.name}? Their devices are disconnected within 15 seconds and cannot connect until you activate them again.`) && void change({ status: "suspended" })}>
                  Suspend
                </Button>
              ) : (
                <Button icon={<UserCheck />} onClick={() => void change({ status: "active" })}>
                  Activate
                </Button>
              ))}
            {can("admin") && (
              <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                Remove
              </Button>
            )}
          </span>
        }
      />
      <Problem error={action.error} />
      {p.status === "suspended" && (
        <Callout tone="warning" title="Suspended">
          None of their devices can connect. Activate them to let their devices back in; their certificates stay valid.
        </Callout>
      )}
      <Devices call={call} person={p} devices={devices.data?.devices} onChange={() => (devices.reload(), person.reload())} />
      <Panel title="Groups" description="Which IP groups their devices reach comes from these.">
        <div className="flex flex-col gap-3">
          <GroupPicker groups={groups.data?.groups ?? []} value={chosen} onChange={setChosen} disabled={!can("editor")} />
          {can("editor") && dirty && (
            <div>
              <Button size="sm" variant="primary" loading={action.busy} onClick={() => void change({ groups: chosen })}>
                Save groups
              </Button>
            </div>
          )}
        </div>
      </Panel>
      <Panel title="Connected now" flush>
        <SessionTable call={call} personId={p.id} />
      </Panel>
    </>
  );
}

function Devices({ call, person, devices, onChange }: { call: Call; person: Person; devices: Device[] | undefined; onChange: () => void }) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<{ name: string; ovpn: string }>();
  const action = useAction();
  const close = () => (setAdding(false), setFile(undefined), setName(""), action.clear());
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(async () => {
      const r = await call<{ device: Device; ovpn: string }>(`/api/v1/people/${person.id}/devices`, { method: "POST", body: JSON.stringify({ name }) });
      const f = { name: `${slug(person.name)}-${slug(r.device.name)}.ovpn`, ovpn: r.ovpn };
      setFile(f);
      download(f.name, f.ovpn);
    });
    if (ok) onChange();
  };
  const revoke = (d: Device) =>
    window.confirm(`Revoke ${d.name}? It is disconnected within 15 seconds and its .ovpn file stops working for good.`) &&
    void action.run(() => call(`/api/v1/devices/${d.id}`, { method: "DELETE" })).then(onChange);
  const columns: Column<Device>[] = [
    { id: "name", header: "Device", cell: (d) => d.name, sortValue: (d) => d.name },
    { id: "ip", header: "VPN address", width: "120px", mono: true, cell: (d) => d.vpnIp },
    {
      id: "state",
      header: "Certificate",
      width: "190px",
      cell: (d) =>
        d.revokedAt ? (
          <Badge tone="danger">Revoked {ago(d.revokedAt)}</Badge>
        ) : Date.parse(d.notAfter) < Date.now() ? (
          <Badge tone="warning">Expired {date(d.notAfter)}</Badge>
        ) : (
          <span className="text-sm">Valid until {date(d.notAfter)}</span>
        ),
      sortValue: (d) => (d.revokedAt ? `0${d.revokedAt}` : `1${d.notAfter}`),
    },
    { id: "created", header: "Added", width: "110px", cell: (d) => ago(d.createdAt), sortValue: (d) => d.createdAt },
    ...(can("editor")
      ? [
          {
            id: "revoke",
            header: "",
            width: "100px",
            cell: (d: Device) =>
              !d.revokedAt && (
                <Button size="xs" variant="ghost" icon={<Ban />} onClick={() => revoke(d)}>
                  Revoke
                </Button>
              ),
          } satisfies Column<Device>,
        ]
      : []),
  ];
  return (
    <Panel
      title="Devices"
      description="One certificate per device, valid for a year. A lost or replaced device is revoked; add a new one for the new device."
      actions={
        can("editor") &&
        person.status === "active" && (
          <Button size="sm" icon={<Laptop />} onClick={() => setAdding(true)}>
            Add device
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {!adding && <Problem error={action.error} />}
        {file ? (
          <Dialog
            open={adding}
            onOpenChange={(open) => !open && close()}
            icon={<Check aria-hidden className="size-4" />}
            iconTone="success"
            title="Device added. Send its file now"
            description={`${file.name} downloaded. It holds the device's private key; they import it into an OpenVPN client.`}
            footer={
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            }
          >
            <Callout tone="warning" title="This VPN does not keep the file">
              It cannot be downloaded again once this dialog closes. Send it privately.
            </Callout>
            <span>
              <Button icon={<Download />} onClick={() => download(file.name, file.ovpn)}>
                Download again
              </Button>
            </span>
          </Dialog>
        ) : (
          <Dialog
            open={adding}
            onOpenChange={(open) => !open && close()}
            title={`Add a device for ${person.name}`}
            description="It gets its own certificate and VPN address. Its .ovpn file downloads once."
            onSubmit={add}
            footer={
              <>
                <Button type="button" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" icon={<Download />} loading={action.busy} disabled={!name}>
                  Add and download
                </Button>
              </>
            }
          >
            <Problem error={action.error} title="Not added" />
            <TextField label="Device" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work laptop" />
          </Dialog>
        )}
        {devices && devices.length === 0 ? (
          <EmptyState title="No devices yet">
            Add one; you get its .ovpn file once.
          </EmptyState>
        ) : (
          <List label={`Devices of ${person.name}`} rows={devices} columns={columns} empty="No devices" getRowId={(d) => d.id} />
        )}
      </div>
    </Panel>
  );
}
