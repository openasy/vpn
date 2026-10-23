import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, navigate, PageHeader, Panel, StatusBadge, Switch, TextField, type Column } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Ban, Check, Download, Laptop, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Device, Group, Person } from "./api.ts";
import { useT } from "./i18n.ts";
import { SessionTable } from "./sessions.tsx";
import { ago, date, download, List, Problem, slug, useAction, useData, type Call } from "./shared.tsx";

function PersonStatus({ status }: { status: Person["status"] }) {
  const t = useT();
  return <StatusBadge tone={status === "active" ? "success" : "warning"}>{status === "active" ? t("people.active") : t("people.suspended")}</StatusBadge>;
}

/** Ticks for every group; the names are what the API takes. */
function GroupPicker({ groups, value, onChange, disabled }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const t = useT();
  if (!groups.length) return <span className="text-sm text-fg-muted">{t("people.noGroups")}</span>;
  return (
    <div className="flex flex-wrap gap-3">
      {groups.map((g) => (
        <Checkbox
          key={g.id}
          label={g.name}
          checked={value.includes(g.name)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? [...value, g.name] : value.filter((n) => n !== g.name))}
        />
      ))}
    </div>
  );
}

export function PeoplePage({ call }: { call: Call }) {
  const { can } = useAuth();
  const t = useT();
  const { data, reload } = useData<{ people: Person[] }>(call, "/api/v1/people");
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const [adding, setAdding] = useState(false);
  const columns: Column<Person>[] = [
    { id: "name", header: t("common.name"), cell: (p) => <a href={`/people/${p.id}`}>{p.name}</a>, sortValue: (p) => p.name },
    { id: "email", header: t("common.email"), cell: (p) => p.email, sortValue: (p) => p.email },
    { id: "status", header: t("common.status"), width: "120px", cell: (p) => <PersonStatus status={p.status} />, sortValue: (p) => p.status },
    {
      id: "groups",
      header: t("common.groups"),
      cell: (p) =>
        p.groups.length ? (
          <span className="flex flex-wrap gap-1">
            {p.groups.map((g) => (
              <Badge key={g}>{g}</Badge>
            ))}
          </span>
        ) : (
          "–"
        ),
    },
    { id: "devices", header: t("common.devices"), width: "90px", align: "right", mono: true, cell: (p) => p.devices, sortValue: (p) => p.devices },
  ];
  return (
    <>
      <PageHeader
        title={t("people.title")}
        description={t("people.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("people.add")}
            </Button>
          )
        }
      />
      {adding && <AddPerson call={call} groups={groups.data?.groups ?? []} onDone={(p) => (setAdding(false), reload(), p && navigate(`/people/${p.id}`))} />}
      {data?.people.length === 0 ? (
        <EmptyState title={t("people.nobody")} action={can("editor") && <Button onClick={() => setAdding(true)}>{t("people.addFirst")}</Button>}>
          {t("people.emptyBody")}
        </EmptyState>
      ) : (
        <Panel flush>
          <List label={t("people.title")} rows={data?.people} columns={columns} empty={t("people.nobody")} getRowId={(p) => p.id} />
        </Panel>
      )}
    </>
  );
}

function AddPerson({ call, groups, onDone }: { call: Call; groups: Group[]; onDone: (p?: Person) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let created: Person | undefined;
    if (
      await action.run(async () => (created = await call<Person>("/api/v1/people", { method: "POST", body: JSON.stringify({ name, email, groups: chosen }) })))
    )
      onDone(created);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      title={t("people.addTitle")}
      description={t("people.addBody")}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" onClick={() => onDone()}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={action.busy} disabled={!name || !email}>
            {t("people.add")}
          </Button>
        </>
      }
    >
      <Problem error={action.error} title={t("common.notAdded")} />
      <TextField label={t("common.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana Kim" />
      <TextField label={t("common.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dana@example.com" />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t("common.groups")}</legend>
        <GroupPicker groups={groups} value={chosen} onChange={setChosen} />
      </fieldset>
    </Dialog>
  );
}

export function PersonPage({ call, id }: { call: Call; id: string }) {
  const { can } = useAuth();
  const t = useT();
  const person = useData<Person>(call, `/api/v1/people/${id}`, 0);
  const devices = useData<{ devices: Device[] }>(call, `/api/v1/people/${id}/devices`, 0);
  const groups = useData<{ groups: Group[] }>(call, "/api/v1/groups", 0);
  const action = useAction();
  const [chosen, setChosen] = useState<string[]>([]);
  const p = person.data;
  useEffect(() => setChosen(p?.groups ?? []), [p]);
  if (person.error) return <EmptyState title={t("people.notFound")}>{person.error}</EmptyState>;
  if (!p) return null;
  const change = (body: object) =>
    action.run(() => call<Person>(`/api/v1/people/${id}`, { method: "PATCH", body: JSON.stringify(body) })).then(() => person.reload());
  const remove = () =>
    window.confirm(t("people.confirmRemove", { name: p.name })) &&
    void action.run(() => call(`/api/v1/people/${id}`, { method: "DELETE" })).then((ok) => ok && navigate("/people"));
  const dirty = chosen.slice().sort().join("\n") !== p.groups.slice().sort().join("\n");
  return (
    <>
      <PageHeader
        title={p.name}
        description={p.email}
        breadcrumbs={[{ label: t("people.title"), href: "/people" }, { label: p.name }]}
        meta={<PersonStatus status={p.status} />}
        actions={
          <span className="flex flex-wrap gap-2">
            {can("editor") &&
              (p.status === "active" ? (
                <Button icon={<UserX />} onClick={() => window.confirm(t("people.confirmSuspend", { name: p.name })) && void change({ status: "suspended" })}>
                  {t("people.suspend")}
                </Button>
              ) : (
                <Button icon={<UserCheck />} onClick={() => void change({ status: "active" })}>
                  {t("people.activate")}
                </Button>
              ))}
            {can("admin") && (
              <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                {t("common.remove")}
              </Button>
            )}
          </span>
        }
      />
      <Problem error={action.error} />
      {p.status === "suspended" && (
        <Callout tone="warning" title={t("people.suspended")}>
          {t("people.suspendedBody")}
        </Callout>
      )}
      <Devices call={call} person={p} devices={devices.data?.devices} onChange={() => (devices.reload(), person.reload())} />
      <Panel title={t("common.groups")} description={t("people.groupsBody")}>
        <div className="flex flex-col gap-3">
          <GroupPicker groups={groups.data?.groups ?? []} value={chosen} onChange={setChosen} disabled={!can("editor")} />
          {can("editor") && dirty && (
            <div>
              <Button size="sm" variant="primary" loading={action.busy} onClick={() => void change({ groups: chosen })}>
                {t("people.saveGroups")}
              </Button>
            </div>
          )}
        </div>
      </Panel>
      <Panel title={t("people.connectedNow")} flush>
        <SessionTable call={call} personId={p.id} />
      </Panel>
    </>
  );
}

function Devices({ call, person, devices, onChange }: { call: Call; person: Person; devices: Device[] | undefined; onChange: () => void }) {
  const { can } = useAuth();
  const t = useT();
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
    window.confirm(t("devices.confirmRevoke", { name: d.name })) && void action.run(() => call(`/api/v1/devices/${d.id}`, { method: "DELETE" })).then(onChange);
  // The install's internal names (ADR 0054): each device may turn them off, and keeps the connection it had.
  const names = useData<{ domain: string | null }>(call, "/api/v1/internal-names", 0);
  const setNames = (d: Device, on: boolean) =>
    void action.run(() => call(`/api/v1/devices/${d.id}`, { method: "PATCH", body: JSON.stringify({ internalNames: on }) })).then(onChange);
  const columns: Column<Device>[] = [
    { id: "name", header: t("common.device"), cell: (d) => d.name, sortValue: (d) => d.name },
    { id: "ip", header: t("common.vpnAddress"), width: "120px", mono: true, cell: (d) => d.vpnIp },
    {
      id: "state",
      header: t("devices.certificate"),
      width: "190px",
      cell: (d) =>
        d.revokedAt ? (
          <Badge tone="danger">{t("devices.revoked", { when: ago(t, d.revokedAt) })}</Badge>
        ) : Date.parse(d.notAfter) < Date.now() ? (
          <Badge tone="warning">{t("devices.expired", { date: date(d.notAfter) })}</Badge>
        ) : (
          <span className="text-sm">{t("devices.validUntil", { date: date(d.notAfter) })}</span>
        ),
      sortValue: (d) => (d.revokedAt ? `0${d.revokedAt}` : `1${d.notAfter}`),
    },
    { id: "created", header: t("common.added"), width: "110px", cell: (d) => ago(t, d.createdAt), sortValue: (d) => d.createdAt },
    ...(names.data?.domain
      ? [
          {
            id: "names",
            header: t("devices.internalNames"),
            width: "120px",
            cell: (d: Device) =>
              !d.revokedAt && (
                <Switch
                  checked={d.internalNames}
                  onCheckedChange={(on) => setNames(d, on)}
                  disabled={!can("editor")}
                  label={<span className="sr-only">{t("devices.internalNamesFor", { name: d.name })}</span>}
                />
              ),
          } satisfies Column<Device>,
        ]
      : []),
    ...(can("editor")
      ? [
          {
            id: "revoke",
            header: "",
            width: "100px",
            cell: (d: Device) =>
              !d.revokedAt && (
                <Button size="xs" variant="ghost" icon={<Ban />} onClick={() => revoke(d)}>
                  {t("devices.revoke")}
                </Button>
              ),
          } satisfies Column<Device>,
        ]
      : []),
  ];
  return (
    <Panel
      title={t("common.devices")}
      description={t("devices.description")}
      actions={
        can("editor") &&
        person.status === "active" && (
          <Button size="sm" icon={<Laptop />} onClick={() => setAdding(true)}>
            {t("devices.add")}
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
            title={t("devices.addedTitle")}
            description={t("devices.addedBody", { file: file.name })}
            footer={
              <Button variant="primary" onClick={close}>
                {t("common.done")}
              </Button>
            }
          >
            <Callout tone="warning" title={t("devices.notKept")}>
              {t("devices.notKeptBody")}
            </Callout>
            <span>
              <Button icon={<Download />} onClick={() => download(file.name, file.ovpn)}>
                {t("devices.downloadAgain")}
              </Button>
            </span>
          </Dialog>
        ) : (
          <Dialog
            open={adding}
            onOpenChange={(open) => !open && close()}
            title={t("devices.addFor", { name: person.name })}
            description={t("devices.addBody")}
            onSubmit={add}
            footer={
              <>
                <Button type="button" onClick={close}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" variant="primary" icon={<Download />} loading={action.busy} disabled={!name}>
                  {t("devices.addAndDownload")}
                </Button>
              </>
            }
          >
            <Problem error={action.error} title={t("common.notAdded")} />
            <TextField label={t("common.device")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("devices.placeholder")} />
          </Dialog>
        )}
        {devices && devices.length === 0 ? (
          <EmptyState title={t("devices.noneYet")}>{t("devices.noneYetBody")}</EmptyState>
        ) : (
          <List label={t("devices.of", { name: person.name })} rows={devices} columns={columns} empty={t("devices.none")} getRowId={(d) => d.id} />
        )}
      </div>
    </Panel>
  );
}
