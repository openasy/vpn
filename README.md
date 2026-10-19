# vpn-manager

The [OpenAsy](https://github.com/openasy) VPN product: API and web UI for OpenVPN servers, in one container with one version.
OpenVPN itself runs on hosts as the separate [vpn-server](https://github.com/openasy/vpn-server) agent.

> **For testing only.** This release has no sign-in yet (ADR 0002): the management API uses one shared
> `VPN_ADMIN_TOKEN`, and the CA key is stored unencrypted in the database (ADR 0021). Both come in the next phase.

## Run

```bash
export VPN_SERVER_TOKEN=$(openssl rand -hex 32) VPN_ADMIN_TOKEN=$(openssl rand -hex 32)
export VPN_PUBLIC_HOST=vpn.example.com   # the name or IP clients connect to
docker compose up -d
```

[`compose.yaml`](./compose.yaml) starts `ghcr.io/openasy/vpn-manager` and two `ghcr.io/openasy/vpn-server` agents, one on
UDP 1194 and one on TCP 443. The UI and API are on http://127.0.0.1:8080; the API reference with *Try it out* is at
http://127.0.0.1:8080/api/docs/ (click *Authorize* and paste `VPN_ADMIN_TOKEN`).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `VPN_MANAGER_DB` | `/data/vpn-manager.db` | SQLite file (WAL), on the `/data` volume |
| `VPN_ADMIN_TOKEN` | | Bearer token for the management API and UI; everything is refused without it |
| `VPN_SERVER_TOKEN` | | Token vpn-server agents send; they are refused without it |
| `VPN_PUBLIC_HOST` | | Host name or IP clients connect to; needed to add devices |
| `VPN_NETWORK` | `10.8.0.0/24` | Address pool for clients; each device gets a fixed address from it |
| `VPN_MANAGER_HEADLESS` | `false` | `true` serves only the API |

## Give someone access

```bash
API=http://127.0.0.1:8080/api/v1; AUTH="Authorization: Bearer $VPN_ADMIN_TOKEN"
curl -sH "$AUTH" $API/groups -d '{"name":"Backend engineers"}'
curl -sH "$AUTH" $API/ip-groups -d '{"name":"Production databases","networks":[{"cidr":"172.16.20.0/24","ports":"tcp/5432"}],"allowedGroups":["Backend engineers"]}'
curl -sH "$AUTH" $API/people -d '{"name":"Dana Kim","email":"dana@example.com","groups":["Backend engineers"]}'
curl -sH "$AUTH" $API/people/<person id>/devices -d '{"name":"Laptop"}' | jq -r .ovpn > dana-laptop.ovpn
```

The `.ovpn` file holds the device's private key and is shown only once; vpn-manager does not keep the key. Import it
into any OpenVPN client. Servers pick up a new device within one heartbeat (15 seconds), so a connection right after
download may be refused once.

How it works:

- vpn-manager holds the CA and issues one certificate and one fixed VPN address per device.
- Each vpn-server pulls the config for its server from `GET /api/v1/servers/{id}/config` (with `ETag`, so an unchanged
  config costs a 304), writes it for OpenVPN and restarts OpenVPN only when certificates or the server settings change.
- Only listed devices may connect (`ccd-exclusive`). Revoking a device puts it on the CRL, which OpenVPN checks on every
  new connection; suspending a person removes their devices until they are active again.
- Each device gets routes to the networks of the IP groups its person's groups may use, or all traffic for a full-tunnel
  IP group. The server's firewall lets it reach only those networks and ports; everything else from the device is
  dropped, including other devices and the server itself.
- Servers report live sessions every heartbeat: `GET /api/v1/sessions`. A device that is revoked, suspended or deleted
  is disconnected at the next heartbeat. `DELETE /api/v1/sessions/{server}/{device}` ends one session; the device may
  reconnect if it is still allowed.
- A client config lists the servers vpn-manager knows when the file is created, so start the servers before adding devices.

Not built yet: the people, access and sessions screens in the UI, and the CLI.

## Endpoints

| Path | |
| --- | --- |
| `/healthz`, `/readyz` | Liveness and readiness |
| `/metrics` | Prometheus metrics |
| `GET /api/v1/version` | Product and version |
| `GET /api/v1/servers` | Known VPN servers |
| `POST /api/v1/servers/heartbeat` | Used by vpn-server |
| `GET /api/v1/servers/{id}/config` | Used by vpn-server: what its OpenVPN must run |
| `/api/v1/people`, `/api/v1/people/{id}/devices`, `/api/v1/devices/{id}` | People and their devices |
| `/api/v1/groups`, `/api/v1/ip-groups` | Groups, and the networks each group may reach |
| `GET /api/v1/sessions`, `DELETE /api/v1/sessions/{server}/{device}` | Devices connected now; end a session |
| `/api/docs/` | Interactive API reference (Swagger UI), bundled in the image |
| `/api/openapi.json` | OpenAPI 3.1 description |

The description lives in [`openapi.json`](./openapi.json) and is the contract: `server/openapi.test.ts` calls every
operation and fails if a response does not match it. Errors are RFC 9457 Problem Details
(`application/problem+json`) with a stable `code`. The reference is also on the site, without "Try it":
https://openasy.github.io/products/vpn/api

## Verify an image

Images are signed with cosign (keyless), carry an SPDX SBOM attestation and SLSA level 3 provenance.

```bash
cosign verify ghcr.io/openasy/vpn-manager:0.1.0 \
  --certificate-identity-regexp '^https://github.com/openasy/vpn-manager/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type spdxjson ghcr.io/openasy/vpn-manager:0.1.0 \
  --certificate-identity-regexp '^https://github.com/openasy/vpn-manager/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
slsa-verifier verify-image ghcr.io/openasy/vpn-manager@sha256:<digest> --source-uri github.com/openasy/vpn-manager
```

## Develop

```bash
npm ci
npm start      # API on :8080 (set VPN_MANAGER_DB=./data/vpn-manager.db)
npm run dev    # web UI on :5173, proxies /api
npm run typecheck && npm test
e2e/run.sh     # needs Docker and the vpn-manager:dev and vpn-server:dev images: a real OpenVPN client connects,
               # reaches an allowed port, is blocked on another, is disconnected, and is refused after revoke
```

Node runs the TypeScript sources in `server/` directly; there is no build step for the server.

## Release

1. Set `version` in `package.json`, merge to `main`.
2. Push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. GitHub Actions tests, builds `linux/amd64` and `linux/arm64`, pushes `ghcr.io/openasy/vpn-manager:0.1.0` and `:0.1` to GitHub Container Registry
   (never `latest`), signs it, attaches the SBOM and provenance, and creates the GitHub release.
4. Release vpn-server with the same version.

Long-term patches for Enterprise customers are tagged from `lts/X.Y` branches ([ADR 0020](https://github.com/openasy/openasy.github.io/blob/main/docs/decisions/0020-long-term-support.md)).
The workflow uses its own `GITHUB_TOKEN`; no secrets are needed.

## Design decisions

See [openasy.github.io/principles](https://openasy.github.io/principles) and the records in [openasy.github.io `docs/decisions`](https://github.com/openasy/openasy.github.io/tree/main/docs/decisions).

## Licence

[AGPL-3.0](./LICENSE). You may use, change and share it; if you run a changed version for others, including as a
hosted service, you must offer them your source code under the same licence. A commercial licence without these
obligations is available: see [ADR 0008](https://github.com/openasy/openasy.github.io/blob/main/docs/decisions/0008-open-source.md).
"OpenAsy" and its logo are trademarks and are not covered by the licence.
