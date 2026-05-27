/**
 * Integration test: BullMQ → worker.runTask → NodeStateUpdateEvent → Collab task-listener → Yjs
 *
 * End-to-end test of the Phase 2 canvas-native flow with real infrastructure:
 *   - Real PostgreSQL (testcontainers): task rows, FK fixtures (user/project)
 *   - Real Redis (testcontainers): BullMQ queue + Redis Streams event bus
 *   - Real @breatic/core modules: taskService, DB schema
 *   - Real @breatic/collab: handleNodeStateUpdateEvent + startTaskListener
 *   - In-process Hocuspocus: DirectConnection for Yjs doc pre-population + assertion
 *   - Mocked provider boundary: resolveMiniToolEntry → local kind + runLocalHandler (synthetic)
 *
 * What this catches that unit tests can't:
 *   - Queue name typos (worker listens on wrong queue)
 *   - Missing payload fields (job.data fields not reaching the handler)
 *   - Redis stream key mismatches (collab consumer reads wrong stream)
 *   - Yjs data path bugs (wrong Y.Map nesting, wrong field key)
 *   - FK constraint failures in DB fixture setup
 *
 * @see packages/collab/src/task-listener.ts
 * @see packages/worker/src/handlers.ts
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  inject,
} from "vitest";
import * as Y from "yjs";
import { Worker, Queue } from "bullmq";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// ── Mock `ai` BEFORE any other import ───────────────────────────────────────
//
// `ai` (Vercel AI SDK) imports @opentelemetry/api whose ESM build
// (build/esm/index.js) uses bare relative imports (e.g. './baggage/utils')
// that Node.js native ESM rejects (strict ESM requires .js extensions).
//
// Mocking `ai` here prevents the broken ESM chain from loading. We only
// need generateText, streamText, stepCountIs, and tool — used by @breatic/core
// and worker providers — but our tests only exercise the mini-tool path where
// runLocalHandler is mocked. Providing stubs is sufficient; they are never called.

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  // tool() is used by @breatic/core/agent/llm-tools/* — return a minimal stub
  tool: (config: Record<string, unknown>) => config,
}));

// ── Mock the provider boundary BEFORE any worker/core module is imported ────
//
// Strategy:
//   1. Mock resolveMiniToolEntry → always return { kind: 'local', handler: 'test/mock' }
//   2. Mock runLocalHandler → return values from a per-test controller object
//   3. Mock downloadAndStore + getStorageAdapter → no-op URL passthrough
//   4. Everything else (DB, Redis, BullMQ) is real
//
// This intercepts at the highest-level boundary: the provider call in runMiniTool.
// runTask, taskService, publishNodeEvent, and the Collab consumer all run for real.

// Controller mutated per test to drive success / failure / multi-output scenarios
const providerCtrl = {
  mode: "success" as "success" | "failure" | "multi",
  outputs: [{ url: "https://oss/result.png", cover_url: "https://oss/thumb.png" }],
  error: new Error("Synthetic provider error"),
};

// Must be hoisted before the module imports below
vi.mock("@breatic/worker/src/mini-tool-registry.js", () => ({
  resolveMiniToolEntry: () => ({ kind: "local", handler: "test/mock" }),
}));

vi.mock("@breatic/worker/src/handlers/local/index.js", () => ({
  runLocalHandler: async () => {
    if (providerCtrl.mode === "failure") {
      throw providerCtrl.error;
    }
    return {
      outputs: providerCtrl.outputs.map((o) => ({
        url: o.url,
        cover_url: o.cover_url,
      })),
      cost: 0,
    };
  },
}));

// Storage: passthrough — URLs look like permanent storage already
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    downloadAndStore: async (url: string) => url,
    getStorageAdapter: async () => ({
      upload: async (_key: string, _data: Buffer, _contentType: string) =>
        "https://oss/uploaded",
      persistFromUrl: async (url: string) => url,
    }),
    storageKey: () => "test/key.png",
  };
});

// ── Import real modules AFTER mocks are registered ──────────────────────────
// NOTE: process.env is already set by integration-setup.ts (setupFiles runs
// before test file evaluation), so @breatic/core env.ts sees the correct URLs.

import { runTask } from "@breatic/worker/src/handlers.js";
import type { TaskJobData } from "@breatic/worker/src/handlers.js";
import { taskService, schema } from "@breatic/core";
import { startTaskListener } from "@breatic/collab/src/task-listener.js";
import { canvasSpaceDocName } from "@breatic/shared";

// Declare the shape of values provided by globalSetup.setup() via provide().
// Vitest uses declaration merging on this interface to type inject() calls.
// This mirrors the same declaration in integration-setup.ts.
declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
    REDIS_QUEUE_URL: string;
    REDIS_STREAM_URL: string;
  }
}

// ── Infrastructure state ─────────────────────────────────────────────────────

let hocuspocus: Hocuspocus;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wsServer: any; // Server from @hocuspocus/server — typed as any to avoid circular type issues
// Persistent anchor connection: keeps the project canvas document loaded
// in Hocuspocus memory across seedNode/readNodeData calls.
// Hocuspocus unloads a document when the last connection closes, so any
// disconnect() in seedNode/readNodeData would lose all Y.Map state. The
// anchor connection prevents that by keeping the document resident.
let anchorConn: Awaited<ReturnType<Hocuspocus["openDirectConnection"]>> | null = null;
let stopTaskListener: () => Promise<void>;
let bullWorker: Worker<TaskJobData>;
let tasksQueue: Queue<TaskJobData>;
let pgClient: ReturnType<typeof postgres>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any; // typed as any to sidestep drizzle-orm version mismatch between
             // @breatic/core (drizzle-orm@0.38.x, typed schema) and
             // the server devDependency (drizzle-orm@0.43.x, typed drizzle())

// Fixture IDs — inserted once, reused across all tests
const FIXTURE_USER_ID = "00000000-0000-0000-0000-000000000001";
const FIXTURE_PROJECT_ID = "00000000-0000-0000-0000-000000000002";
// v10: every project belongs to a Studio. Personal-Studio fixture so
// the FK on projects.studio_id can be satisfied alongside the
// existing user fixture.
const FIXTURE_STUDIO_ID = "00000000-0000-0000-0000-000000000003";
// v10 multi-doc: every task carries a spaceId; the worker writes back
// to `project-{pid}/canvas-{spaceId}`. Spaces have no PG table, so
// this is just a stable UUID we reuse across tasks in the test.
const FIXTURE_SPACE_ID = "00000000-0000-0000-0000-000000000004";

// ── Polling helpers ──────────────────────────────────────────────────────────

/**
 * Poll `checkFn` every 100 ms until it returns true or timeoutMs elapses.
 *
 * @throws Error with `label` if condition not met within timeoutMs
 */
async function waitForCondition(
  checkFn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkFn()) return;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition '${label}' not met within ${timeoutMs}ms`);
}

/**
 * Read the data Y.Map snapshot for a node from a live Hocuspocus document.
 *
 * Opens a DirectConnection, snapshots field→value pairs from the data Y.Map,
 * then disconnects. Returns null if the node or data map is absent.
 */
async function readNodeData(
  hp: Hocuspocus,
  docName: string,
  nodeId: string,
): Promise<Record<string, unknown> | null> {
  let result: Record<string, unknown> | null = null;
  const conn = await hp.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "test-assertion" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      // v10 layout: nodesMap lives at the top level of the canvas-{sid}
      // doc, not nested under a `canvas` wrapper Map.
      const nodesMap = doc.getMap("nodesMap");
      const nodeMap = nodesMap.get(nodeId);
      if (!(nodeMap instanceof Y.Map)) return;
      const dataMap = nodeMap.get("data");
      if (!(dataMap instanceof Y.Map)) return;

      const snap: Record<string, unknown> = {};
      for (const [k, v] of dataMap.entries()) {
        // Flatten nested Y.Maps (handlingBy) to plain objects for assertions
        snap[k] = v instanceof Y.Map ? Object.fromEntries(v.entries()) : v;
      }
      result = snap;
    });
  } finally {
    await conn.disconnect();
  }
  return result;
}

/**
 * Pre-populate a canvas node in a Hocuspocus document.
 *
 * Mirrors the v10 Yjs canvas structure:
 *   doc.getMap("nodesMap")[nodeId].data = Y.Map(dataFields)
 *
 * Plain object values are set directly; nested plain-object values are
 * converted to Y.Map (for handlingBy etc.).
 */
async function seedNode(
  hp: Hocuspocus,
  docName: string,
  nodeId: string,
  dataFields: Record<string, unknown>,
): Promise<void> {
  const conn = await hp.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "test-seed" },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      // v10 layout — nodesMap is the top-level Y.Map on the
      // canvas-{spaceId} doc.
      const nodesMap = doc.getMap("nodesMap");

      const dataMap = new Y.Map();
      for (const [k, v] of Object.entries(dataFields)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          const nested = new Y.Map();
          for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
            nested.set(nk, nv);
          }
          dataMap.set(k, nested);
        } else {
          dataMap.set(k, v);
        }
      }

      const posMap = new Y.Map<unknown>([["x", 100], ["y", 200]]);
      const nodeMap = new Y.Map<unknown>([
        ["id", nodeId],
        ["type", "1002"],
        ["position", posMap],
        ["data", dataMap],
      ]);

      nodesMap.set(nodeId, nodeMap);
    });
  } finally {
    await conn.disconnect();
  }
}

// ── beforeAll / afterAll ─────────────────────────────────────────────────────

beforeAll(async () => {
  const DATABASE_URL = inject("DATABASE_URL") as string;
  const REDIS_QUEUE_URL = inject("REDIS_QUEUE_URL") as string;
  const REDIS_STREAM_URL = inject("REDIS_STREAM_URL") as string;

  // 1. DB connection for fixture insertion (separate pool from @breatic/core singleton)
  pgClient = postgres(DATABASE_URL, { max: 3 });
  db = drizzle(pgClient);

  // 2. Insert FK fixture rows: user → studio → project + owner membership
  //    (v10: projects.studio_id NOT NULL + project_members owner row required
  //     for any later requireRole-gated route to admit the user).
  await db.insert(schema.users).values({
    id: FIXTURE_USER_ID,
    email: "integration-test@breatic.example",
    emailVerified: true,
  }).onConflictDoNothing();

  await db.insert(schema.studios).values({
    id: FIXTURE_STUDIO_ID,
    ownerUserId: FIXTURE_USER_ID,
    name: "Integration Test Studio",
  }).onConflictDoNothing();

  await db.insert(schema.projects).values({
    id: FIXTURE_PROJECT_ID,
    studioId: FIXTURE_STUDIO_ID,
    createdByUserId: FIXTURE_USER_ID,
    name: "Integration Test Project",
  }).onConflictDoNothing();

  await db.insert(schema.projectMembers).values({
    projectId: FIXTURE_PROJECT_ID,
    userId: FIXTURE_USER_ID,
    role: "owner",
    addedBy: null,
  }).onConflictDoNothing();

  // 3. Start in-process Hocuspocus — minimal config, no PG/Redis extensions.
  //    Documents are held in memory. DirectConnection works without a listening
  //    WebSocket port (port:0 = ephemeral, but we never connect via WebSocket).
  wsServer = new Server({
    port: 0,
    quiet: true,
    extensions: [],
  });
  hocuspocus = wsServer.hocuspocus;
  await wsServer.listen();

  // Open a persistent anchor connection to the project canvas document so that
  // Hocuspocus never unloads it between seedNode / readNodeData calls.
  // (Hocuspocus unloads a doc when the last connection closes — without an anchor,
  // disconnect() in seedNode would erase all Y.Map state before readNodeData runs.)
  const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
  anchorConn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "test-anchor" },
  });

  // 4. Start Collab task-listener on the dev Redis stream.
  //    envPrefix = "dev" → stream key: dev:stream:task-events
  //    This must match taskEventsStreamKey() in @breatic/core/infra/event-stream.ts,
  //    which uses `${env.ENV}:stream:task-events` — and ENV="dev" in integration-setup.ts.
  stopTaskListener = startTaskListener(
    hocuspocus,
    REDIS_STREAM_URL,
    "dev",
  );

  // 5. Start BullMQ Worker calling runTask — same setup as worker/src/index.ts
  const queueUrl = new URL(REDIS_QUEUE_URL);
  const bullConnection = {
    host: queueUrl.hostname,
    port: Number(queueUrl.port) || 6379,
    db: Number(queueUrl.pathname.slice(1)) || 0,
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
  };

  bullWorker = new Worker<TaskJobData>("tasks", runTask, {
    connection: bullConnection,
    concurrency: 1,
    lockDuration: 30_000,
    // Only 1 attempt so failure tests resolve quickly
    settings: { backoffStrategy: () => 500 },
  });

  // 6. Queue for submitting test jobs
  tasksQueue = new Queue<TaskJobData>("tasks", { connection: bullConnection });

  // Wait for the worker to signal readiness (or settle after 500ms)
  await new Promise<void>((resolve) => {
    bullWorker.on("ready", resolve);
    setTimeout(resolve, 500);
  });
}, 120_000);

afterAll(async () => {
  await tasksQueue.close();
  await bullWorker.close(true); // force close to avoid waiting for active jobs
  await stopTaskListener();
  // Close anchor connection before destroying wsServer
  if (anchorConn) await anchorConn.disconnect();
  // Destroy via wsServer (Server wrapper) — hocuspocus (core) has no .destroy()
  await wsServer.destroy();
  await pgClient.end();
}, 60_000);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("canvas-native flow: BullMQ → runTask → Redis stream → Collab → Yjs", () => {

  /**
   * Test 1 — Success path: handling → idle
   *
   * Invariants:
   *   - state becomes 'idle'
   *   - content is set to the provider URL
   *   - cover_url is set
   *   - handlingBy is deleted (not merely null)
   *   - errorMessage is absent
   */
  it("Test 1: success path — state=idle, content+cover_url written, handlingBy deleted", async () => {
    const nodeId = "node-success-t1";
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    providerCtrl.mode = "success";
    providerCtrl.outputs = [{
      url: "https://oss/result-t1.png",
      cover_url: "https://oss/thumb-t1.png",
    }];

    await seedNode(hocuspocus, docName, nodeId, {
      name: "Success Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, username: "alice" },
      attachments: [],
    });

    // Verify the seed took effect
    const seeded = await readNodeData(hocuspocus, docName, nodeId);
    expect(seeded?.["state"]).toBe("handling");

    // Insert task DB row
    const [taskRow] = await db.insert(schema.tasks).values({
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      taskType: "image",
      mode: "append",
      source: "mini_tool",
      params: {},
    }).returning();
    const taskId = taskRow!.id as string;

    // Enqueue job with full Phase 2 payload shape
    await tasksQueue.add("run-task", {
      taskId,
      taskType: "image",
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      source: "mini_tool",
      toolName: "remove-bg",
      params: {},
      targetNodeIds: [nodeId],
      mode: "append" as const,
    }, { attempts: 1 });

    // Wait for task to complete in DB
    await waitForCondition(
      async () => {
        const t = await taskService.getByIdInternal(taskId);
        return t?.status === "completed";
      },
      30_000,
      `task ${taskId} completed`,
    );

    // Wait for Yjs node to reflect the result
    await waitForCondition(
      async () => {
        const d = await readNodeData(hocuspocus, docName, nodeId);
        return d?.["state"] === "idle" && typeof d?.["content"] === "string";
      },
      5_000,
      `node ${nodeId} state=idle with content`,
    );

    const data = await readNodeData(hocuspocus, docName, nodeId);
    expect(data).not.toBeNull();
    // State machine
    expect(data!["state"]).toBe("idle");
    // Content fields
    expect(data!["content"]).toBe("https://oss/result-t1.png");
    expect(data!["cover_url"]).toBe("https://oss/thumb-t1.png");
    // handlingBy MUST be absent (deleted, not set to undefined/null)
    expect("handlingBy" in (data ?? {})).toBe(false);
    // No error on success
    expect("errorMessage" in (data ?? {})).toBe(false);
  });

  /**
   * Test 2 — Failure path: handling → idle + errorMessage
   *
   * Invariants:
   *   - state becomes 'idle'
   *   - errorMessage is set and non-empty
   *   - content is NOT touched (retains its prior value if any, or absent if absent)
   *   - handlingBy is deleted
   */
  it("Test 2: failure path — state=idle, errorMessage set, content unchanged", async () => {
    const nodeId = "node-failure-t2";
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    providerCtrl.mode = "failure";
    providerCtrl.error = new Error("Synthetic AIGC provider error for test 2");

    // Seed with existing content — must remain untouched after failure
    await seedNode(hocuspocus, docName, nodeId, {
      name: "Failure Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, username: "bob" },
      content: "https://oss/prior-content.png",
      attachments: [],
    });

    const [taskRow] = await db.insert(schema.tasks).values({
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      taskType: "image",
      mode: "append",
      source: "mini_tool",
      params: {},
    }).returning();
    const taskId = taskRow!.id as string;

    await tasksQueue.add("run-task", {
      taskId,
      taskType: "image",
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      source: "mini_tool",
      toolName: "remove-bg",
      params: {},
      targetNodeIds: [nodeId],
      mode: "append" as const,
    }, { attempts: 1 }); // 1 attempt so it fails fast without retries

    // Wait for task DB status → failed
    await waitForCondition(
      async () => {
        const t = await taskService.getByIdInternal(taskId);
        return t?.status === "failed";
      },
      30_000,
      `task ${taskId} failed`,
    );

    // Wait for Yjs to reflect the failure
    await waitForCondition(
      async () => {
        const d = await readNodeData(hocuspocus, docName, nodeId);
        return d?.["state"] === "idle" && typeof d?.["errorMessage"] === "string";
      },
      5_000,
      `node ${nodeId} state=idle with errorMessage`,
    );

    const data = await readNodeData(hocuspocus, docName, nodeId);
    expect(data).not.toBeNull();
    // State machine
    expect(data!["state"]).toBe("idle");
    // Error message present and non-empty
    expect(typeof data!["errorMessage"]).toBe("string");
    expect((data!["errorMessage"] as string).length).toBeGreaterThan(0);
    // Prior content must NOT be overwritten by the failure path
    expect(data!["content"]).toBe("https://oss/prior-content.png");
    // handlingBy cleared
    expect("handlingBy" in (data ?? {})).toBe(false);
  });

  /**
   * Test 3 — Multi-output fanout: 1 task → N nodes
   *
   * Invariants:
   *   - All N nodes transition to state=idle
   *   - Each node has the URL from its corresponding output slot (index-aligned)
   *   - handlingBy cleared on all nodes
   */
  it("Test 3: multi-output fanout — 3 nodes each receive their distinct content URL", async () => {
    const nodeIds = ["node-fan-t3-a", "node-fan-t3-b", "node-fan-t3-c"];
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    providerCtrl.mode = "multi";
    providerCtrl.outputs = [
      { url: "https://oss/fanout-1.png", cover_url: "https://oss/fanout-thumb-1.png" },
      { url: "https://oss/fanout-2.png", cover_url: "https://oss/fanout-thumb-2.png" },
      { url: "https://oss/fanout-3.png", cover_url: "https://oss/fanout-thumb-3.png" },
    ];

    // Seed all 3 nodes in handling state
    for (const nodeId of nodeIds) {
      await seedNode(hocuspocus, docName, nodeId, {
        name: `Fanout Node ${nodeId}`,
        state: "handling",
        handlingBy: { userId: FIXTURE_USER_ID, username: "carol" },
        attachments: [],
      });
    }

    const [taskRow] = await db.insert(schema.tasks).values({
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      taskType: "image",
      mode: "append",
      source: "mini_tool",
      params: {},
    }).returning();
    const taskId = taskRow!.id as string;

    await tasksQueue.add("run-task", {
      taskId,
      taskType: "image",
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      source: "mini_tool",
      toolName: "multi-angle",
      params: {},
      targetNodeIds: nodeIds,
      mode: "append" as const,
    }, { attempts: 1 });

    // Wait for task to complete
    await waitForCondition(
      async () => {
        const t = await taskService.getByIdInternal(taskId);
        return t?.status === "completed";
      },
      30_000,
      `task ${taskId} completed (fanout)`,
    );

    // Wait for all 3 nodes to be idle with content
    await waitForCondition(
      async () => {
        const checks = await Promise.all(
          nodeIds.map(async (id) => {
            const d = await readNodeData(hocuspocus, docName, id);
            return d?.["state"] === "idle" && typeof d?.["content"] === "string";
          }),
        );
        return checks.every(Boolean);
      },
      5_000,
      "all 3 fanout nodes state=idle with content",
    );

    // Assert each node has the index-aligned URL
    for (let i = 0; i < nodeIds.length; i++) {
      const data = await readNodeData(hocuspocus, docName, nodeIds[i]!);
      expect(data).not.toBeNull();
      expect(data!["state"]).toBe("idle");
      expect(data!["content"]).toBe(providerCtrl.outputs[i]!.url);
      expect(data!["cover_url"]).toBe(providerCtrl.outputs[i]!.cover_url);
      expect("handlingBy" in (data ?? {})).toBe(false);
    }
  });
});
