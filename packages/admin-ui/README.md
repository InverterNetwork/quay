# Quay Admin UI

React/Vite Admin UI for the Quay Admin API.

## Local development

Start the Quay API from the monorepo root:

```bash
bun run build
./dist/quay serve
```

Start the UI:

```bash
bun run admin-ui:dev
```

The UI reads `http://127.0.0.1:9731` by default. Override it for local
development with:

```bash
VITE_QUAY_API_BASE_URL=http://127.0.0.1:9731 bun run dev
```

For hosted builds, set `window.__QUAY_API_BASE_URL__` before the app bundle
loads to configure the API endpoint at runtime.

## API contract

The versioned Admin API contract is owned by the Quay repo at
`docs/api/openapi.yaml`. This UI keeps a small local
TypeScript client aligned to the `/v1/meta`, `/v1/repos`, `/v1/repos/:id`,
`/v1/global`, `/v1/matrix`, `/v1/changes/preview`, and `/v1/changes/apply`
operations from that contract. Writes are sent as structured JSON changes and
are guarded by the revision returned with the read model.

## Legacy repository

This source was migrated from `InverterNetwork/quay-ui`. That repository should
remain read-only with a pointer to this workspace, or be archived after any
remaining consumers move to this monorepo.
