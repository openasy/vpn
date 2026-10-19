# vpn-manager

The [OpenAsy](https://github.com/openasy) VPN product: API and web UI for OpenVPN servers, in one container with one version.
OpenVPN itself runs on hosts as the separate [vpn-server](https://github.com/openasy/vpn-server) agent.

## Run

```bash
export VPN_SERVER_TOKEN=$(openssl rand -hex 32)
docker compose up -d
```

[`compose.yaml`](./compose.yaml) starts `ghcr.io/openasy/vpn-manager` and two `ghcr.io/openasy/vpn-server` agents, one on UDP 1194 and one on TCP 443. The UI is on http://localhost:8080.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `VPN_MANAGER_DB` | `/data/vpn-manager.db` | SQLite file (WAL), on the `/data` volume |
| `VPN_SERVER_TOKEN` | | Token vpn-server agents send; heartbeats are refused without it |
| `VPN_MANAGER_HEADLESS` | `false` | `true` serves only the API |

## Endpoints

| Path | |
| --- | --- |
| `/healthz`, `/readyz` | Liveness and readiness |
| `/metrics` | Prometheus metrics |
| `GET /api/v1/version` | Product and version |
| `GET /api/v1/servers` | Known VPN servers |
| `POST /api/v1/servers/heartbeat` | Used by vpn-server |
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
