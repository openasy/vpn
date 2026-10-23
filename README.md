# vpn

The [OpenAsy](https://github.com/openasy) VPN product: API and web UI for OpenVPN servers, in one container with one version.
OpenVPN itself runs on hosts as the separate [vpn-server](https://github.com/openasy/vpn-server), which carries the
VPN traffic and takes its config from `vpn` (ADR 0018).

People sign in with an account (password plus authenticator app or passkey), with a passkey alone, or through your
identity provider (OIDC). Each person has a role in this VPN; scripts use API tokens. See [Sign-in](#sign-in).

> The CA key, server keys and sign-in secrets are sealed with `openasy-kek` (ADR 0021). Keep that file apart from the
> `/data` volume and with your backups: a backup without it cannot issue certificates, and vpn does not start
> without it.

## Run

```bash
export VPN_PUBLIC_HOST=vpn.example.com   # the name or IP clients connect to
openssl rand -hex 32 > openasy-kek
docker compose up -d vpn
docker compose logs vpn | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). Then add the
two servers under **Servers**, `edge-1` and `edge-1-tcp`, and start them with their one-time tokens:

```bash
EDGE_1_TOKEN=ove_... EDGE_1_TCP_TOKEN=ove_... docker compose up -d
```

[`compose.yaml`](./compose.yaml) starts `ghcr.io/openasy/vpn` and two `ghcr.io/openasy/vpn-server` servers, one on
UDP 1194 and one on TCP 443. The UI and API are on http://localhost:8080; the API reference with *Try it out* is at
http://localhost:8080/api/docs/ (click *Authorize* and paste an API token).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `VPN_DB` | `/data/vpn.db` | SQLite file (WAL), on the `/data` volume |
| `VPN_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy. Cookies, passkeys and OIDC redirects use it |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher: `identity=https://id.example.com,infrastructure=https://infra.example.com`. Give every product the same value |
| `VPN_SERVER_TOKEN` | | Deprecated: one token for servers set up before 0.6.0, which never enrolled. Enrol them, then remove it |
| `VPN_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key; required. It seals the CA key, server keys and sign-in secrets in the database (ADR 0021) |
| `VPN_PASSWORD_SIGN_IN` | `true` | `false` when everyone signs in through OIDC |
| `OPENASY_OIDC_*` | | Sign-in through your identity provider, the same names in every product, see [Sign-in](#sign-in) |
| `VPN_ADMIN_TOKEN` | | Deprecated: one shared admin token without an expiry, for scripts from before sign-in. Use an API token |
| `VPN_PUBLIC_HOST` | | Host name or IP clients connect to, for servers added without an address of their own |
| `VPN_NETWORK` | `10.8.0.0/24` | Address pool for clients; each device gets a fixed address from it |
| `VPN_HEADLESS` | `false` | `true` serves only the API |

## Sign-in

Sign-in comes from [@openasy/auth](https://github.com/openasy/auth), the same in every OpenAsy product (ADR 0002).

- **Roles** (ADR 0003): viewers see everything; editors also add people and devices, revoke devices and end sessions;
  admins also remove people and manage groups, IP groups, members and API tokens; owners also manage owners. Owners
  and admins who sign in with a password must add an authenticator app or a passkey.
- **Members**: admins invite people under Settings → Members and send them the one-time link (there is no email yet).
  These are the people who manage the VPN, not the VPN users under `/api/v1/people`.
- **API tokens**: Settings → API tokens. One role each, an expiry within a year, shown once.
- **Settings, Sign-in**: owners add an identity provider in the UI instead: OpenAsy Identity, Keycloak, Microsoft Entra
  ID, Okta, Google, authentik, ZITADEL or any OpenID Connect provider. The page shows that provider's steps and the
  redirect URI to register, checks the issuer, and maps groups to roles; the client secret is kept encrypted.
- **OIDC**: register `vpn` with the redirect URI `<VPN_PUBLIC_URL>/api/v1/auth/oidc/sso/callback` and set
  `OPENASY_OIDC_ISSUER`, `OPENASY_OIDC_CLIENT_ID` and `OPENASY_OIDC_CLIENT_SECRET`. Optional: `OPENASY_OIDC_PROVIDER`,
  `OPENASY_OIDC_NAME`, `OPENASY_OIDC_SCOPES`, `OPENASY_OIDC_GROUPS_CLAIM`, `OPENASY_OIDC_ROLE_MAPPING`
  (`vpn-admins=admin,staff=viewer`), `OPENASY_OIDC_DEFAULT_ROLE` and `OPENASY_OIDC_ALLOWED_DOMAINS`.
  `OPENASY_OIDC_AUTO_REDIRECT=true` makes the sign-in page open the provider straight away; `?local=1` still shows the
  VPN's own form. The names are the same in every OpenAsy product, so an install sets them once; only the client is
  the VPN's. The names before 0.5.0 of `@openasy/auth`, such as `VPN_OIDC_ISSUER`, still work for now and log a warning.

## Give someone access

In the UI: add a group and an IP group under **Access**, a person under **People**, then a device on their page. The
`.ovpn` file downloads once. The same with the [command line tool](#command-line):

```bash
openasy-vpn groups add "Backend engineers"
openasy-vpn ip-groups add "Production databases" --network 172.16.20.0/24=tcp/5432 --allow "Backend engineers"
openasy-vpn people add "Dana Kim" dana@example.com --group "Backend engineers"
openasy-vpn devices add dana@example.com Laptop   # writes dana-kim-laptop.ovpn, readable by you only
```

Or with the API directly:

```bash
# VPN_API_TOKEN: an API token with the admin role, from Settings → API tokens
API=http://localhost:8080/api/v1; AUTH="Authorization: Bearer $VPN_API_TOKEN"
curl -sH "$AUTH" $API/groups -d '{"name":"Backend engineers"}'
curl -sH "$AUTH" $API/ip-groups -d '{"name":"Production databases","networks":[{"cidr":"172.16.20.0/24","ports":"tcp/5432"}],"allowedGroups":["Backend engineers"]}'
curl -sH "$AUTH" $API/people -d '{"name":"Dana Kim","email":"dana@example.com","groups":["Backend engineers"]}'
curl -sH "$AUTH" $API/people/<person id>/devices -d '{"name":"Laptop"}' | jq -r .ovpn > dana-laptop.ovpn
```

The `.ovpn` file holds the device's private key and is shown only once; `vpn` does not keep the key. Import it
into any OpenVPN client. Servers pick up a new device within one heartbeat (15 seconds), so a connection right after
download may be refused once.

How it works:

- An admin adds each server under Servers, with the address clients connect to, and gets a one-time enrolment token.
  vpn-server trades it for its own secret (ADR 0032); a secret speaks for its server only.

- `vpn` holds the CA and issues one certificate and one fixed VPN address per device.
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
- A client config lists every server that has reported, each at its address, UDP first. The client tries them in turn,
  so when a server or a location is down it connects to the next. Every server carries every device, with the same
  VPN address; each server NATs its clients, so the networks behind it see the server's address.
- The list is fixed when the file is created: start the servers before adding devices. A server added later reaches
  only devices added after it. Give locations DNS names, so that moving a server needs no new client configs.

### Several locations

Run vpn-server on a host at each location and add it under Servers with that host's address; the page shows the
command to start it. The hosts need to reach `vpn` over HTTPS and the networks their clients use. `vpn` never connects
to them (ADR 0023).

## Command line

`openasy-vpn` uses the same API as the UI, with an API token from Settings, API tokens; the token's role decides what
it may do. It is one file with no dependencies and needs Node 26. Download it from the release, or run it from the
image without installing anything:

```bash
export VPN_URL=https://vpn.example.com VPN_API_TOKEN=oa_vpn_...
curl -LO https://github.com/openasy/vpn/releases/download/v0.8.0/openasy-vpn.ts
node openasy-vpn.ts help
node openasy-vpn.ts sessions

# Next to vpn, with compose.yaml: nothing to install, and VPN_URL is not needed
docker compose exec -T -e VPN_API_TOKEN vpn /nodejs/bin/node cli/openasy-vpn.ts people
# Anywhere with Docker
docker run --rm -e VPN_URL -e VPN_API_TOKEN ghcr.io/openasy/vpn:0.8.0 cli/openasy-vpn.ts people
```

`devices add` never overwrites a file; `--out -` prints the `.ovpn` instead, for example to pass it on in a pipe.
`--json` prints the API's answers as they are, for scripts.

## Endpoints

| Path | |
| --- | --- |
| `/healthz`, `/readyz` | Liveness and readiness |
| `/metrics` | Prometheus metrics |
| `GET /api/v1/version` | Product and version |
| `GET /api/v1/products` | The other OpenAsy products, from `OPENASY_PRODUCTS` |
| `GET /api/v1/servers`, `POST /api/v1/servers` | VPN servers; add one and get its enrolment token |
| `PATCH`, `DELETE /api/v1/servers/{id}`, `POST /api/v1/servers/{id}/enroll-token` | Change a server's address, remove it, enrol it again |
| `POST /api/v1/servers/enroll` | Used by vpn-server once: trades the enrolment token for its secret |
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

## Upgrade

### To 0.7.0

- The sign-in variables lose the `VPN_` prefix and have the same names in every product (ADR 0002): `VPN_OIDC_ISSUER`
  is now `OPENASY_OIDC_ISSUER`, and so on for every `VPN_OIDC_*`. The old names still work, with a warning in the log,
  and go in a later release: rename them.
- `VPN_SERVER_TOKEN` still works, and is removed in 0.8.0.

### To 0.6.0

- Servers are added under Servers and enrol with their own token (ADR 0032). Servers that report with
  `VPN_SERVER_TOKEN` keep working and are shown as *Legacy*. To move one, click *Enrol*, start it with
  `VPN_ENROLL_TOKEN` and its state directory on a volume (`compose.yaml` adds `vpn-server-data`), then remove
  `VPN_SERVER_TOKEN` once no server is legacy. `VPN_SERVER_TOKEN` is removed in 0.8.0.
- An enrolled server cannot be reached with `VPN_SERVER_TOKEN`, and a server's secret fetches only its own config.
- `GET /api/v1/servers` adds `address`, `status`, `legacy` and `createdAt`; `version` and `lastSeen` are null for a
  server that has not reported yet.

### To 0.5.0

- `openasy-kek` is required. `compose.yaml` mounts it since 0.3.0; with `docker run`, mount it at
  `/run/secrets/openasy-kek`. vpn refuses to start without it, or with a different key than the one it sealed with.
- On the first start the CA key, the tls-crypt key and the server keys are sealed in place. Certificates already
  issued stay valid. Upgrades are forward-only (ADR 0010): after this start, 0.4.0 cannot use the sealed keys.

### From vpn-manager

Until 0.4.0 this product was called vpn-manager (ADR 0018). The image is now `ghcr.io/openasy/vpn`; the old images stay
published but get no new versions.

- `VPN_MANAGER_PUBLIC_URL`, `VPN_MANAGER_DB` and `VPN_MANAGER_HEADLESS` are now `VPN_PUBLIC_URL`, `VPN_DB` and
  `VPN_HEADLESS`; vpn-server's `VPN_MANAGER_URL` is now `VPN_URL`. The old names still work, with a warning in the
  log, until 0.5.0.
- `/data/vpn-manager.db` is renamed to `/data/vpn.db` on the first start. Nothing else in it changes.
- In `compose.yaml` the service is now `vpn` and the volume `vpn-data`. A new volume name means an empty volume, so
  copy the old one first, or the CA and every device are gone:

```bash
docker compose down
docker volume create <project>_vpn-data
docker run --rm -v <project>_vpn-manager-data:/from -v <project>_vpn-data:/to alpine cp -a /from/. /to/
```

`docker volume ls` shows the name of the old volume.

## Verify an image

Images are signed with cosign (keyless), carry an SPDX SBOM attestation and SLSA level 3 provenance.

```bash
cosign verify ghcr.io/openasy/vpn:0.8.0 \
  --certificate-identity-regexp '^https://github.com/openasy/vpn/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type spdxjson ghcr.io/openasy/vpn:0.8.0 \
  --certificate-identity-regexp '^https://github.com/openasy/vpn/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
slsa-verifier verify-image ghcr.io/openasy/vpn@sha256:<digest> --source-uri github.com/openasy/vpn
```

## Develop

```bash
npm ci
npm start      # API on :8080 (set VPN_DB=./data/vpn.db)
npm run dev    # web UI on :5173, proxies /api
npm run typecheck && npm test
e2e/run.sh     # needs Docker and the vpn:dev and vpn-server:dev images: a real OpenVPN client connects,
               # reaches an allowed port, is blocked on another, is disconnected, and is refused after revoke
```

Node runs the TypeScript sources in `server/` directly; there is no build step for the server.

The web UI speaks English, Turkish and German; the top bar has a language menu next to the theme. Its words are in
`web/src/messages/en.json`, `tr.json` and `de.json`, read with i18next through `@openasy/ui` (its ADR 0006). A key
missing in a language fails the typecheck, and `web/src/messages.test.ts` checks the placeholders.

## Release

1. Set `version` in `package.json`, merge to `main`.
2. Push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. GitHub Actions tests, builds `linux/amd64` and `linux/arm64`, pushes `ghcr.io/openasy/vpn:0.1.0` and `:0.1` to GitHub Container Registry
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
