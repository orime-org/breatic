/**
 * Canvas-native E2E integration test.
 *
 * Validates the Phase 2 backend pipeline end-to-end with real PostgreSQL +
 * Redis infrastructure (no mocking of integration boundaries):
 *
 *   publishNodeEvent → Redis stream (dev:stream:task-events)
 *   → task-listener XREAD loop → Hocuspocus openDirectConnection
 *   → doc.transact("node-state-update") → nodesMap.get(nodeId).get("data").set(…)
 *
 * Catches wiring bugs that mock-based unit tests miss — e.g. queue name typo
 * (PR #16), wrong stream key, missing payload fields, allowlist mismatches.
 *
 * Infrastructure: Testcontainers spins up postgres:16-alpine + redis:7-alpine.
 * Container boot + migration takes ~30–60 s; that is why this file uses a
 * 180 000 ms hook timeout and is excluded from the default test run.
 *
 * Design note on @breatic/core:
 *   We intentionally do NOT import from @breatic/core in this file.
 *   The reason: @breatic/core's dist/index.js imports from the Vercel AI SDK
 *   which depends on @opentelemetry/api. Vitest's module loader (even in
 *   forks mode) resolves @opentelemetry/api to its broken ESM build that
 *   uses bare extension-less imports. To avoid this, we implement only the
 *   thin wrappers we need (publishNodeEvent, runMigrations) inline using
 *   ioredis, drizzle-orm, and postgres directly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import * as Y from "yjs";
import Redis from "ioredis";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the migrations folder relative to this file.
// From packages/server/src/__tests__/integration/ we go up to find core/src/db/migrations.
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(THIS_DIR, "../../../../core/src/db/migrations");

// ── Container handles ─────────────────────────────────────────────────────────
let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pgConnString: string;
let redisUrlBase: string;

// ── Module handles ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hocuspocus: any;
let stopTaskListener: () => Promise<void>;
// Redis client for publishing test events on the stream DB (index 2).
let streamRedis: Redis;

/** Fixture UUIDs (stable across this test run). */
const TEST_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_USER_ID    = "22222222-2222-2222-2222-222222222222";

// ENV is "dev" (matches Zod schema) → stream key = "dev:stream:task-events".
const ENV_PREFIX = "dev";

// ── publishNodeEvent (inline — avoids loading @breatic/core → ai chain) ──────

type NodeStateUpdate = {
  state?: "idle" | "handling";
  content?: string | null;
  cover_url?: string | null;
  errorMessage?: string | null;
  // null = "clear this field" (survives JSON round-trip; undefined is stripped)
  handlingBy?: { userId: string; username: string } | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  name?: string | null; // intentionally allowed to test allowlist filtering
};

interface NodeStateUpdateEvent {
  type: "node-state-update";
  docName: string;
  nodeId: string;
  update: NodeStateUpdate;
}

/** Publish a NodeStateUpdateEvent to the Redis stream. */
async function publishNodeEvent(event: NodeStateUpdateEvent): Promise<void> {
  const streamKey = `${ENV_PREFIX}:stream:task-events`;
  await streamRedis.xadd(
    streamKey,
    "MAXLEN",
    "~",
    "10000",
    "*",
    "payload",
    JSON.stringify(event),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Navigate to a node's data Y.Map in a doc, or return null if absent. */
function getDataMap(doc: Y.Doc, nodeId: string): Y.Map<unknown> | null {
  const nodesMap = doc.getMap("canvas").get("nodesMap");
  if (!(nodesMap instanceof Y.Map)) return null;
  const nodeMap = nodesMap.get(nodeId);
  if (!(nodeMap instanceof Y.Map)) return null;
  const dataMap = nodeMap.get("data");
  return dataMap instanceof Y.Map ? dataMap : null;
}

/**
 * Write nodes into a project Yjs document via DirectConnection.
 */
async function seedCanvasDoc(
  docName: string,
  nodes: Array<{ id: string; dataFields: Record<string, unknown> }>,
): Promise<void> {
  const conn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "test-seed" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      const canvasMap = doc.getMap("canvas");
      let nodesMap = canvasMap.get("nodesMap");
      if (!(nodesMap instanceof Y.Map)) {
        nodesMap = new Y.Map();
        canvasMap.set("nodesMap", nodesMap as Y.Map<unknown>);
      }
      for (const { id, dataFields } of nodes) {
        const nodeMap = new Y.Map<unknown>();
        const dataMap = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(dataFields)) {
          dataMap.set(k, v);
        }
        nodeMap.set("data", dataMap);
        (nodesMap as Y.Map<unknown>).set(id, nodeMap);
      }
    });
  } finally {
    await conn.disconnect();
  }
}

/**
 * Poll the Yjs doc until `nodeId`'s data.state equals `expected`.
 * Throws if the state hasn't changed within `timeoutMs` milliseconds.
 */
async function waitForNodeState(
  nodeId: string,
  docName: string,
  expected: string,
  timeoutMs = 6_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let current: unknown;
    const conn = await hocuspocus.openDirectConnection(docName, {
      context: { user: { id: "test" }, source: "test-poll" },
    });
    try {
      await conn.transact((doc: Y.Doc) => {
        current = getDataMap(doc, nodeId)?.get("state");
      });
    } finally {
      await conn.disconnect();
    }
    if (current === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${nodeId}.state did not reach '${expected}' within ${timeoutMs}ms`);
}

/** Read a single field from a node's data Y.Map. */
async function readField(nodeId: string, docName: string, field: string): Promise<unknown> {
  let value: unknown;
  const conn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "test" }, source: "test-read" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      value = getDataMap(doc, nodeId)?.get(field);
    });
  } finally {
    await conn.disconnect();
  }
  return value;
}

/** Check whether a nodeId exists in the canvas's nodesMap. */
async function nodeExists(nodeId: string, docName: string): Promise<boolean> {
  let exists = false;
  const conn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "test" }, source: "test-read" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      const nodesMap = doc.getMap("canvas").get("nodesMap");
      if (nodesMap instanceof Y.Map) exists = nodesMap.has(nodeId);
    });
  } finally {
    await conn.disconnect();
  }
  return exists;
}

// ── Container lifecycle ───────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Start PG + Redis in parallel.
  [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("breatic_test")
      .withUsername("breatic")
      .withPassword("breatic")
      .start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);

  pgConnString = pgContainer.getConnectionUri();
  redisUrlBase = redisContainer.getConnectionUrl();

  // 2. Run Drizzle migrations directly (no @breatic/core, avoids ai → opentelemetry chain).
  const migrationClient = postgres(pgConnString, { max: 1 });
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await migrationClient.end();

  // 3. Seed user + project fixtures (FK required by tasks / node_history).
  const sql = postgres(pgConnString, { max: 2 });
  await sql`
    INSERT INTO users (id, email, username, email_verified, credits)
    VALUES (
      ${TEST_USER_ID}::uuid,
      'testuser@integration.test',
      'testuser',
      true,
      1000.0
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO projects (id, user_id, name)
    VALUES (
      ${TEST_PROJECT_ID}::uuid,
      ${TEST_USER_ID}::uuid,
      'Integration Test Project'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql.end();

  // 4. Create Hocuspocus with PG + Redis extensions.
  //    Import from collab package source (TypeScript). Vitest transforms it.
  const collabServerPath = new URL("../../../../collab/src/server.ts", import.meta.url);
  const { createCollabServer } = await import(collabServerPath.pathname);
  const { hocuspocus: hp } = await createCollabServer({
    databaseUrl: pgConnString,
    redisUrl:       `${redisUrlBase}/0`,
    streamRedisUrl: `${redisUrlBase}/2`,
    envPrefix: ENV_PREFIX,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  hocuspocus = hp;
  // We do NOT call server.listen() — DirectConnection works without a
  // running WebSocket port, keeping the test hermetic (no port binding).

  // 5. Start the task listener (subscribes to the Redis stream).
  const taskListenerPath = new URL("../../../../collab/src/task-listener.ts", import.meta.url);
  const { startTaskListener } = await import(taskListenerPath.pathname);
  stopTaskListener = startTaskListener(hocuspocus, `${redisUrlBase}/2`, ENV_PREFIX);

  // 6. Create a Redis client for publishing test events.
  //    DB 2 = stream DB (matches envPrefix:stream:task-events key).
  streamRedis = new Redis(`${redisUrlBase}/2`);
}, 180_000);

afterAll(async () => {
  if (stopTaskListener) await stopTaskListener();
  await streamRedis?.quit();
  await pgContainer?.stop();
  await redisContainer?.stop();
}, 90_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stream → task-listener → Yjs: event routing with real Redis + Hocuspocus", () => {
  /**
   * Happy path: worker emits NodeStateUpdateEvent {state:'idle', content, handlingBy:undefined}.
   * The task-listener must write all three fields to the node's data Y.Map.
   *
   * Invariants:
   *   - state === 'idle'          (transition from handling → idle)
   *   - content === CONTENT_URL   (new content URL set)
   *   - handlingBy absent         (Y.Map.delete, not set to null)
   */
  it("handling → idle (success): state=idle + content written; handlingBy deleted", async () => {
    const NODE_ID = "node-success-001";
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;
    const CONTENT_URL = "https://cdn.example.com/output-success-001.png";

    await seedCanvasDoc(DOC_NAME, [
      {
        id: NODE_ID,
        dataFields: {
          name: "Test Image Node",
          state: "handling",
          handlingBy: { userId: TEST_USER_ID, username: "testuser" },
        },
      },
    ]);

    await publishNodeEvent({
      type: "node-state-update",
      docName: DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        content: CONTENT_URL,
        handlingBy: null,
      },
    });

    await waitForNodeState(NODE_ID, DOC_NAME, "idle");

    expect(await readField(NODE_ID, DOC_NAME, "state")).toBe("idle");
    expect(await readField(NODE_ID, DOC_NAME, "content")).toBe(CONTENT_URL);
    // handlingBy: undefined → Y.Map.delete — key must not exist.
    expect(await readField(NODE_ID, DOC_NAME, "handlingBy")).toBeUndefined();
  });

  /**
   * Failure path: worker emits {state:'idle', errorMessage, handlingBy:undefined}.
   * Prior content must be preserved (not overwritten by the failure event).
   *
   * Invariants:
   *   - state === 'idle'
   *   - errorMessage is set
   *   - prior content URL unchanged
   *   - handlingBy absent
   */
  it("handling → idle (failure): errorMessage written; prior content preserved; handlingBy deleted", async () => {
    const NODE_ID = "node-failure-001";
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;
    const PRIOR_CONTENT = "https://cdn.example.com/prior-content.png";
    const ERROR_MSG = "upstream provider: connection reset by peer";

    await seedCanvasDoc(DOC_NAME, [
      {
        id: NODE_ID,
        dataFields: {
          name: "Test Failure Node",
          state: "handling",
          handlingBy: { userId: TEST_USER_ID, username: "testuser" },
          content: PRIOR_CONTENT,
        },
      },
    ]);

    await publishNodeEvent({
      type: "node-state-update",
      docName: DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        errorMessage: ERROR_MSG,
        handlingBy: null,
        // content intentionally absent — prior value must be preserved
      },
    });

    await waitForNodeState(NODE_ID, DOC_NAME, "idle");

    expect(await readField(NODE_ID, DOC_NAME, "state")).toBe("idle");
    expect(await readField(NODE_ID, DOC_NAME, "errorMessage")).toBe(ERROR_MSG);
    expect(await readField(NODE_ID, DOC_NAME, "content")).toBe(PRIOR_CONTENT);
    expect(await readField(NODE_ID, DOC_NAME, "handlingBy")).toBeUndefined();
  });

  /**
   * Multi-output (1:N) fanout: worker emits one event per node.
   * Each node receives its own content URL — routing is per-nodeId.
   *
   * Invariants (for each i in 0..2):
   *   - NODE_IDS[i].state === 'idle'
   *   - NODE_IDS[i].content === CONTENT_URLS[i]  (no cross-contamination)
   *   - NODE_IDS[i].handlingBy absent
   */
  it("multi-output (1:N) fanout: 3 nodes each reach idle with distinct content URLs", async () => {
    const NODE_IDS = ["node-fan-001", "node-fan-002", "node-fan-003"];
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;
    const CONTENT_URLS = [
      "https://cdn.example.com/fan-output-1.png",
      "https://cdn.example.com/fan-output-2.png",
      "https://cdn.example.com/fan-output-3.png",
    ];

    await seedCanvasDoc(
      DOC_NAME,
      NODE_IDS.map((id, i) => ({
        id,
        dataFields: {
          name: `Fanout Node ${i + 1}`,
          state: "handling",
          handlingBy: { userId: TEST_USER_ID, username: "testuser" },
        },
      })),
    );

    // Emit one event per node — matches the worker's Stage 4 loop.
    for (let i = 0; i < NODE_IDS.length; i++) {
      await publishNodeEvent({
        type: "node-state-update",
        docName: DOC_NAME,
        nodeId: NODE_IDS[i]!,
        update: {
          state: "idle",
          content: CONTENT_URLS[i]!,
          handlingBy: null,
        },
      });
    }

    // Wait for all nodes to reach idle in parallel.
    // 30s timeout: XREAD blocks up to BLOCK_MS (5s) per call; with 3 events
    // and prior-test events in the stream, processing can spread across
    // multiple XREAD rounds. 30s is well within the 120s test timeout.
    await Promise.all(NODE_IDS.map((id) => waitForNodeState(id, DOC_NAME, "idle", 30_000)));

    for (let i = 0; i < NODE_IDS.length; i++) {
      const id = NODE_IDS[i]!;
      expect(await readField(id, DOC_NAME, "state"),    `${id}.state`).toBe("idle");
      expect(await readField(id, DOC_NAME, "content"),   `${id}.content`).toBe(CONTENT_URLS[i]);
      expect(await readField(id, DOC_NAME, "handlingBy"), `${id}.handlingBy`).toBeUndefined();
    }
  });

  /**
   * Race-safety: event arrives for a node that does not exist in nodesMap
   * (e.g., frontend deleted the node before the task completed).
   *
   * Invariants:
   *   - publishNodeEvent must not throw
   *   - The listener must consume the event without crashing
   *   - nodesMap must NOT gain the ghost nodeId
   */
  it("graceful skip: event for absent nodeId is consumed without crash or phantom node creation", async () => {
    const GHOST_NODE_ID = "node-ghost-999";
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;

    // Seed with an unrelated node so the doc + nodesMap exist.
    await seedCanvasDoc(DOC_NAME, [
      { id: "node-anchor", dataFields: { name: "Anchor", state: "idle" } },
    ]);

    // Must not throw.
    await expect(
      publishNodeEvent({
        type: "node-state-update",
        docName: DOC_NAME,
        nodeId: GHOST_NODE_ID,
        update: { state: "idle", content: "https://cdn.example.com/ghost.png" },
      }),
    ).resolves.not.toThrow();

    // Give the listener time to process the event.
    await new Promise((r) => setTimeout(r, 1_000));

    // The ghost nodeId must NOT appear in nodesMap.
    expect(await nodeExists(GHOST_NODE_ID, DOC_NAME)).toBe(false);
  });

  /**
   * Allowlist enforcement: event payload carries a disallowed field ('name').
   * The listener must drop 'name' and still apply the allowed field (state).
   *
   * Invariants:
   *   - state transitions to 'idle'
   *   - 'name' field in data Y.Map is NOT overwritten by the event
   */
  it("allowlist enforcement: disallowed fields dropped; allowed fields applied", async () => {
    const NODE_ID = "node-allowlist-001";
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;
    const ORIGINAL_NAME = "Original Node Name";

    await seedCanvasDoc(DOC_NAME, [
      {
        id: NODE_ID,
        dataFields: {
          name: ORIGINAL_NAME,
          state: "handling",
          handlingBy: { userId: TEST_USER_ID, username: "testuser" },
        },
      },
    ]);

    await publishNodeEvent({
      type: "node-state-update",
      docName: DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        handlingBy: null,
        // 'name' is NOT in WORKER_UPDATABLE_FIELDS — must be dropped.
        name: "OVERWRITTEN BY ATTACKER",
      },
    });

    await waitForNodeState(NODE_ID, DOC_NAME, "idle");

    // Allowed field applied.
    expect(await readField(NODE_ID, DOC_NAME, "state")).toBe("idle");
    // Disallowed field NOT applied — original name preserved.
    expect(await readField(NODE_ID, DOC_NAME, "name")).toBe(ORIGINAL_NAME);
    expect(await readField(NODE_ID, DOC_NAME, "handlingBy")).toBeUndefined();
  });

  /**
   * Idempotency: publishing the same event twice produces the same final state.
   * Y.Map last-write-wins semantics are safe for duplicate delivery.
   *
   * Invariants:
   *   - After two identical events, state is still 'idle'
   *   - content is the expected URL (not corrupted by duplicate write)
   */
  it("idempotency: duplicate event delivery produces same Y.Map state (last-write-wins)", async () => {
    const NODE_ID = "node-idem-001";
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;
    const CONTENT_URL = "https://cdn.example.com/idempotent.png";

    await seedCanvasDoc(DOC_NAME, [
      {
        id: NODE_ID,
        dataFields: {
          name: "Idempotency Test Node",
          state: "handling",
          handlingBy: { userId: TEST_USER_ID, username: "testuser" },
        },
      },
    ]);

    const event: NodeStateUpdateEvent = {
      type: "node-state-update",
      docName: DOC_NAME,
      nodeId: NODE_ID,
      update: {
        state: "idle",
        content: CONTENT_URL,
        handlingBy: null,
      },
    };

    // Publish twice — simulates BullMQ redelivery.
    await publishNodeEvent(event);
    await publishNodeEvent(event);

    await waitForNodeState(NODE_ID, DOC_NAME, "idle");

    expect(await readField(NODE_ID, DOC_NAME, "state")).toBe("idle");
    expect(await readField(NODE_ID, DOC_NAME, "content")).toBe(CONTENT_URL);
    expect(await readField(NODE_ID, DOC_NAME, "handlingBy")).toBeUndefined();
  });

  /**
   * Stream key regression guard (PR #16 class of bug):
   *
   * The event must be published to `{ENV_PREFIX}:stream:task-events` and the
   * listener must subscribe to the same key. If they diverge (different env
   * prefixes, wrong key name), this test times out — making the wiring bug
   * observable without any mock.
   *
   * Invariants:
   *   - publishNodeEvent with ENV_PREFIX "dev" → the listener (also "dev") processes it
   *   - state reaches 'idle' within the timeout (stream key is correct)
   */
  it("stream key is env-prefixed: dev:stream:task-events (regression guard for PR #16 class)", async () => {
    const NODE_ID = "node-streamkey-001";
    const DOC_NAME = `project-${TEST_PROJECT_ID}`;

    await seedCanvasDoc(DOC_NAME, [
      { id: NODE_ID, dataFields: { name: "Stream Key Test", state: "handling" } },
    ]);

    await publishNodeEvent({
      type: "node-state-update",
      docName: DOC_NAME,
      nodeId: NODE_ID,
      update: { state: "idle", handlingBy: undefined },
    });

    // Succeeds only if the stream key matches what the listener subscribes to.
    // A wrong key (e.g. "test:stream:..." vs "dev:stream:...") will time out.
    await waitForNodeState(NODE_ID, DOC_NAME, "idle", 5_000);
    expect(await readField(NODE_ID, DOC_NAME, "state")).toBe("idle");
  });
});
