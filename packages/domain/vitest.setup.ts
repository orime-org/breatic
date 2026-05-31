/**
 * Vitest global setup for @breatic/domain.
 *
 * Like @breatic/core, domain no longer reads `process.env` itself — the
 * application entry injects validated config via `initCore()`. In tests
 * there is no entry, so this file guarantees the two no-default required
 * vars are present, so a test that calls `initCore()` itself passes the
 * schema validation (fs-sandbox.test injects its own FILE_TOOL_SANDBOX_DIR
 * and calls initCore in beforeAll). Unlike core's setup it does NOT call
 * initCore — initCore is single-shot and that test owns the call.
 *
 * The values only need to satisfy the schema (URL shape + non-empty);
 * these unit tests never open a real connection.
 *
 * Lives OUTSIDE `src/` on purpose: the `lint:no-core-process-env` guard
 * (extended to domain) only scans `src/`, and this harness legitimately
 * reads/sets `process.env` while standing in for the app entry. tsup
 * builds from `src/index.ts`, so this is never bundled.
 */

process.env.DATABASE_URL ??= "postgres://localhost:5432/breatic_test";
process.env.SESSION_SECRET_KEY ??= "test-session-secret-key";
