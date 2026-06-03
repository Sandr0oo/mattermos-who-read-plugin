# Agent Notes

## Plugin type
- **Webapp-only** Mattermost plugin. There is no `server/` directory and no server-side Go code.
- All runtime logic is in `webapp/src/index.tsx` (React/TS plugin registered via `window.registerPlugin`).
- `go.mod` and the Makefile's Go tooling exist only for build scripts under `build/` (manifest generator, deployment helper).

## Build / test prerequisites
- `make apply` must run before building or testing. It generates `webapp/src/manifest.ts` from `plugin.json`.
- `.nvmrc` pins Node `16.13.1`. The webapp uses TypeScript 4.6, React 16, webpack 5, and Jest 27.

## Useful commands
- `make all` — lint + test + bundle.
- `make check-style` — webapp eslint + `tsc` + Go lint (on `build/` only).
- `make test` — Go tests (`build/`) + webapp Jest.
- `make dist` — full build producing `dist/<plugin-id>-<version>.tar.gz`.
- `make watch` — dev build with auto-redeploy on change.
- `make clean` — remove `dist/`, `webapp/node_modules`, `webapp/dist`, `server/` artifacts.

## Verification order
Makefile enforces this in `check-style`:
1. `make apply`
2. `cd webapp && npm run lint`
3. `cd webapp && npm run check-types` (`tsc`)
4. `go vet ./...` + `golangci-lint run ./...` (only hits `build/`)

## Webapp testing
- Tests run with Jest + Enzyme (legacy). Setup file: `webapp/tests/setup.tsx`.
- `jest-canvas-mock` is loaded globally.
- `npm run test` inside `webapp/` is the focused command.

## Quirks
- `plugin.json` is the single source of truth for plugin metadata (id, version, bundle path). The manifest is auto-generated into the source tree, not ignored.
- `go.mod` module path is a stale template name (`github.com/mattermost/mattermost-plugin-starter-template`). It does not match the repo or plugin id. No server plugin code imports it.
- The Makefile auto-installs `golangci-lint@v1.51.1` and `gotestsum@v1.7.0` into `./bin` on first run.
- The webpack watch config auto-runs `make deploy-from-watch` after each rebuild.

## Repo language
README and inline comments are in Russian. The plugin auto-adds/removes the `:eyes:` reaction on the last viewed post to indicate "read".
