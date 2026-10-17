# @breatic/integration-tests

A test package that is never built or deployed. It holds integration tests that drive two or more of server, worker and collab in one run (`src/__tests__/`), and the container start-up every container-backed integration suite shares (`src/test-utils/`). Read section 1.1 of [docs/TEST-MANDATE.md](../../docs/TEST-MANDATE.md) before deciding which package a new test belongs in.

## Shared start-up

**`src/test-utils/containers.ts` (globalSetup), `env.ts` (setupFile) and `provided-context.d.ts` (the `inject()` types) are used by the server, collab and this package's integration configs, so a change there affects all three suites.**

## Dependencies

**Declare only the library packages (`@breatic/core`, `@breatic/domain`, `@breatic/shared`); read server, worker and collab source by path through the `@server`, `@worker` and `@collab` aliases (`tsconfig.json` paths and `vitest.integration.config.ts`).** Server and collab depend on this package for the container start-up, so declaring them back would create a cycle.

**Because turbo cannot see those path reads, `turbo.json` lists the three services' `src/**` in this package's `typecheck` and `lint` inputs.** When this package starts reading another package's source by path, add it there too, or a stale cache passes after that source changes.

**Every package that starts containers declares `testcontainers` and `@testcontainers/postgresql` itself (versions come from the catalog), and every external package a test here `vi.mock`s (such as `ai`) is declared here too.** Vite resolves bare imports from the root of the package that is running, so an undeclared one either fails to resolve or the mock hits a different copy than the code under test loads.

## Running

`pnpm turbo run test:integration --filter=@breatic/integration-tests` (needs Docker).
