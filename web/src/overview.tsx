import {
  BarList,
  Button,
  DonutChart,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  OverviewGrid,
  PageHeader,
  Panel,
  TimeSeriesChart,
  TONE_COLORS,
  type Column,
} from "@openasy/ui";
import { Activity, KeyRound, Laptop, Server as ServerIcon, UsersRound } from "lucide-react";
import type { Overview } from "./api.ts";
import { useT } from "./i18n.ts";
import { bytes, date, List, useData, type Call } from "./shared.tsx";

type Expiring = Overview["devices"]["expiring"][number];

/** Four servers keep their own colour; the rest are one slice, so no colour repeats. */
function top(byServer: Overview["byServer"], other: string) {
  const slices = byServer.slice(0, 4).map((s) => ({ id: s.id, name: s.id, value: s.sessions, href: "/sessions" }));
  const rest = byServer.slice(4).reduce((n, s) => n + s.sessions, 0);
  return rest ? [...slices, { id: "other", name: other, value: rest, color: "var(--oa-fg-subtle)", href: "/sessions" }] : slices;
}

export function OverviewPage({ call }: { call: Call }) {
  const t = useT();
  const o = useData<Overview>(call, "/api/v1/overview", 15_000).data;
  const servers = o ? Object.values(o.servers).reduce((a, b) => a + b, 0) : 0;
  const hour = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const expiringColumns: Column<Expiring>[] = [
    { id: "device", header: t("common.device"), cell: (d) => d.name },
    { id: "person", header: t("sessions.person"), cell: (d) => <a href={`/people/${d.personId}`}>{d.personName}</a> },
    { id: "ends", header: t("overview.ends"), width: "140px", cell: (d) => date(d.notAfter), sortValue: (d) => d.notAfter },
  ];
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      <KpiGrid minWidth={160}>
        <KpiCard label={t("overview.connectedNow")} value={o?.sessions ?? "–"} icon={Activity} trend={o?.hourly.sessions} />
        <KpiCard
          label={t("overview.peopleOnline")}
          value={o?.peopleOnline ?? "–"}
          unit={o ? t("overview.ofActive", { n: o.people.active }) : undefined}
          icon={UsersRound}
        />
        <KpiCard
          label={t("overview.serversOnline")}
          value={o?.servers.online ?? "–"}
          unit={o ? t("overview.ofServers", { n: servers }) : undefined}
          icon={ServerIcon}
          tone={o ? (o.servers.online < servers ? "warning" : "success") : undefined}
          href="/servers"
        />
        <KpiCard label={t("common.devices")} value={o?.devices.active ?? "–"} icon={Laptop} href="/people" />
        <KpiCard
          label={t("overview.certificatesEnding")}
          value={o?.devices.expiring.length ?? "–"}
          icon={KeyRound}
          tone={o ? (o.devices.expiring.length ? "warning" : "success") : undefined}
        />
      </KpiGrid>
      {o && o.people.active + o.people.suspended === 0 ? (
        <EmptyState
          title={t("overview.startTitle")}
          action={
            <Button variant="primary" onClick={() => navigate("/people")}>
              {t("overview.addPeople")}
            </Button>
          }
        >
          {t("overview.startBody")}
        </EmptyState>
      ) : (
        o && (
          <>
            <OverviewGrid>
              <Panel title={t("overview.sessionsPerHour")} description={t("overview.sessionsPerHourDetail")}>
                <TimeSeriesChart
                  label={t("overview.sessionsPerHour")}
                  labels={o.hourly.hours.map(hour)}
                  height={200}
                  series={[{ id: "sessions", name: t("nav.sessions"), data: o.hourly.sessions }]}
                />
              </Panel>
              <Panel title={t("overview.servers")} description={t("overview.serversDetail")}>
                <DonutChart
                  label={t("overview.servers")}
                  caption={t("overview.serversCaption")}
                  slices={[
                    { id: "online", name: t("overview.online"), value: o.servers.online, color: TONE_COLORS.success, href: "/servers" },
                    { id: "offline", name: t("servers.offline"), value: o.servers.offline, color: TONE_COLORS.danger, href: "/servers" },
                    {
                      id: "version-mismatch",
                      name: t("servers.otherVersion"),
                      value: o.servers["version-mismatch"],
                      color: TONE_COLORS.warning,
                      href: "/servers",
                    },
                    { id: "waiting-to-enrol", name: t("servers.waiting"), value: o.servers["waiting-to-enrol"], color: TONE_COLORS.neutral, href: "/servers" },
                  ]}
                />
              </Panel>
            </OverviewGrid>
            <OverviewGrid layout="halves">
              <Panel title={t("sessions.trafficByPerson")} description={t("sessions.inAndOutSinceTheyConnected")}>
                {o.traffic.length ? (
                  <BarList
                    label={t("sessions.trafficByPerson")}
                    format={bytes}
                    items={o.traffic.map((x) => ({ id: x.id, label: x.name, value: x.bytes, ...(x.personId && { href: `/people/${x.personId}` }) }))}
                  />
                ) : (
                  <p className="m-0 text-sm text-fg-muted">{t("sessions.nobody")}</p>
                )}
              </Panel>
              <Panel title={t("sessions.sessionsByServer")} description={t("sessions.connectedNowToEachServer")}>
                {o.byServer.length ? (
                  <DonutChart label={t("sessions.sessionsByServer")} caption={t("overview.connected")} slices={top(o.byServer, t("overview.other"))} />
                ) : (
                  <p className="m-0 text-sm text-fg-muted">{t("sessions.nobody")}</p>
                )}
              </Panel>
            </OverviewGrid>
            {o.devices.expiring.length > 0 && (
              <Panel title={t("overview.certificatesEnding")} description={t("overview.certificatesEndingDetail")} flush>
                <List label={t("overview.certificatesEnding")} rows={o.devices.expiring} columns={expiringColumns} empty="" getRowId={(d) => d.id} />
              </Panel>
            )}
          </>
        )
      )}
    </>
  );
}
