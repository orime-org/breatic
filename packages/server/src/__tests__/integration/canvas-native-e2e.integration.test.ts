// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
  afterEach,
  vi,
  inject,
} from "vitest";
import * as Y from "yjs";
import { Worker, Queue } from "bullmq";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";

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
  // tool() is used by @breatic/core/agent/tools/* — return a minimal stub
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
  mode: "success" as
    | "success"
    | "failure"
    | "multi"
    | "fail-once"
    | "buffer",
  outputs: [{ url: "https://oss/result.png", cover_url: "https://oss/thumb.png" }],
  error: new Error("Synthetic provider error"),
  // fail-once mode: first invocation throws (retryable), later ones succeed.
  calls: 0,
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
    if (providerCtrl.mode === "fail-once") {
      providerCtrl.calls += 1;
      if (providerCtrl.calls === 1) throw providerCtrl.error;
    }
    if (providerCtrl.mode === "buffer") {
      // Sync-transport shape: raw bytes (no output URL) → toUnifiedOutputs
      // routes the buffer into extra.buffer, exercising persistOutputs Case 1.
      return {
        buffer: Buffer.from("synthetic-audio-bytes"),
        contentType: "audio/mp3",
        cost: 0,
      };
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

// Controllable storage stub (asset-layer hardening).
//   failDownload → the re-host throws (hole #4: a persist failure must
//     propagate so Stage 2 markFailed + NO charge; before the fix Case 2
//     swallowed it and billed).
//   contentKey → forces the sha256 so two DIFFERENT provider URLs can
//     share a content hash (hole #1: dedup-hit node-URL reconciliation).
// Default: sha256 derived from the URL, so distinct outputs get distinct
// hashes and multi-output fan-out never falsely dedups/collapses.
const storageCtrl: { failDownload: boolean; contentKey: string | null } = {
  failDownload: false,
  contentKey: null,
};

// Storage: passthrough — URLs look like permanent storage already
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const { createHash } = await import("node:crypto");
  const persist = async (
    sourceUrl: string,
  ): Promise<{
    url: string;
    sha256: string;
    sizeBytes: number;
    contentType: string;
  }> => {
    if (storageCtrl.failDownload) {
      throw new Error(
        "Synthetic re-host failure (test): download/persist failed",
      );
    }
    const hashInput = storageCtrl.contentKey ?? sourceUrl;
    return {
      url: sourceUrl,
      sha256: createHash("sha256").update(hashInput).digest("hex"),
      sizeBytes: Math.max(1, sourceUrl.length),
      contentType: "application/octet-stream",
    };
  };
  return {
    ...orig,
    downloadAndStore: async (url: string) => persist(url),
    getStorageAdapter: async () => ({
      upload: async (_key: string, _data: Buffer, _contentType: string) =>
        "https://oss/uploaded",
      persistFromUrl: async (url: string) => persist(url),
      // Our-own URLs = whatever upload() produced. Provider temp URLs
      // ("https://oss/result-*.png" etc.) are external → re-hosted by Case 2.
      isOwnUrl: (url: string) => url.startsWith("https://oss/uploaded"),
    }),
    storageKey: () => "test/key.png",
  };
});

// ── Import real modules AFTER mocks are registered ──────────────────────────
// NOTE: process.env is already set by integration-setup.ts (setupFiles runs
// before test file evaluation). @breatic/core no longer reads process.env
// itself — it reads injected config via the env Proxy after initCore runs —
// so we call initCore(process.env) below before any real-core access (e.g.
// the `db` Proxy in waitForCondition). `ai` is mocked above, so importing
// the real core barrel here does NOT pull @opentelemetry/api (whose broken
// ESM build crashes the vitest loader); that is why initCore lives here and
// not in the shared setupFile.

import { runTask } from "@breatic/worker/src/handlers/dispatch.js";
import type { TaskJobData } from "@breatic/worker/src/handlers/dispatch.js";
import { initCore, schema, createTestDb } from "@breatic/core";
import { taskService } from "@breatic/domain";
import { startTaskListener } from "@breatic/collab/src/services/task-listener.js";
import { canvasSpaceDocName } from "@breatic/shared";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

initCore(process.env);

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
// Schema-bound Drizzle client built via @breatic/core's createTestDb — core
// is the single home of drizzle-orm, so `db` is fully typed against `schema`
// (no cross-package version-mismatch `any` cast needed).
let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];

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
// A registered user with NO personal studio (mid-onboarding: registration
// creates the user + credit balance but not the studio). Used to exercise
// asset hole #2 — a generation acting as this user cannot resolve an owner
// studio, so registration is best-effort skipped (billed but untracked)
// and must NOT fail the job.
const FIXTURE_USER_NO_STUDIO_ID = "00000000-0000-0000-0000-000000000005";

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
 * Wait until a node's live data Y.Map satisfies `check`, then return the
 * snapshot. The task row reaching a terminal status does NOT mean the node is
 * settled — the worker's done/failed event still has to travel the Redis
 * stream → Collab consumer → Yjs leg, so asserting node state right after
 * waiting on the task status races that application (CI-observed flake
 * 2026-07-16: task `completed` but node still `handling` at read time).
 * Waiting on the node data itself removes the race; callers assert exact
 * values on the returned snapshot afterwards.
 */
async function waitForNodeData(
  hp: Hocuspocus,
  docName: string,
  nodeId: string,
  check: (data: Record<string, unknown>) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | null = null;
  await waitForCondition(
    async () => {
      last = await readNodeData(hp, docName, nodeId);
      return last != null && check(last);
    },
    timeoutMs,
    label,
  );
  return last!;
}

/**
 * Pre-populate a canvas node in a Hocuspocus document.
 *
 * Mirrors the v10 Yjs canvas structure:
 *   doc.getMap("nodesMap")[nodeId].data = Y.Map(dataFields)
 *
 * Every value is set EXACTLY as production does: the web data layer's
 * `buildDataMap` stores nested values (handlingBy, position, attachments)
 * as PLAIN objects/arrays inside the data Y.Map — never as nested Y.Maps.
 * The old harness converted nested objects to Y.Map, which diverged from
 * production and hid the gen-CAS's property reads from the real shape
 * (#1580 adversarial follow-up: harness must mirror production).
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
        dataMap.set(k, v);
      }

      const nodeMap = new Y.Map<unknown>([
        ["id", nodeId],
        ["type", "image"],
        // Plain object, exactly like production addNode's map.set('position', ...).
        ["position", { x: 100, y: 200 }],
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
  const DATABASE_URL = inject("DATABASE_URL");
  const REDIS_QUEUE_URL = inject("REDIS_QUEUE_URL");
  const REDIS_STREAM_URL = inject("REDIS_STREAM_URL");

  // 1. DB connection for fixture insertion (separate pool from @breatic/core singleton)
  ({ db, client: pgClient } = createTestDb(DATABASE_URL));

  // 2. Insert FK fixture rows: user → studio → project + owner membership
  //    (v10: projects.studio_id NOT NULL + project_members owner row required
  //     for any later requireRole-gated route to admit the user).
  await db.insert(schema.users).values({
    id: FIXTURE_USER_ID,
    email: "integration-test@breatic.example",
    emailVerified: true,
  }).onConflictDoNothing();

  // Registered but no personal studio (asset hole #2 fixture).
  await db.insert(schema.users).values({
    id: FIXTURE_USER_NO_STUDIO_ID,
    email: "integration-test-nostudio@breatic.example",
    emailVerified: true,
  }).onConflictDoNothing();

  await db.insert(schema.studios).values({
    id: FIXTURE_STUDIO_ID,
    createdByUserId: FIXTURE_USER_ID,
    slug: "integration-test-studio",
    type: "personal",
    name: "Integration Test Studio",
  }).onConflictDoNothing();

  await db.insert(schema.projects).values({
    id: FIXTURE_PROJECT_ID,
    studioId: FIXTURE_STUDIO_ID,
    createdByUserId: FIXTURE_USER_ID,
    name: "Integration Test Project",
    slug: "integration-test-project",
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
    maxRetriesPerRequest: null,
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
   *   - coverUrl is set
   *   - handlingBy is deleted (not merely null)
   *   - errorMessage is absent
   */
  it("Test 1: success path — state=idle, content+coverUrl written, handlingBy deleted", async () => {
    const nodeId = crypto.randomUUID();
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    providerCtrl.mode = "success";
    providerCtrl.outputs = [{
      url: "https://oss/result-t1.png",
      cover_url: "https://oss/thumb-t1.png",
    }];

    await seedNode(hocuspocus, docName, nodeId, {
      name: "Success Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, type: "frontend", startedAt: Date.now(), gen: 1 },
      leaseGen: 1,
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
    const taskId = taskRow!.id;

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
      nodeGens: { [nodeId]: 1 },
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
    expect(data!["coverUrl"]).toBe("https://oss/thumb-t1.png");
    // handlingBy MUST be absent (deleted, not set to undefined/null)
    expect("handlingBy" in (data ?? {})).toBe(false);
    // No error on success
    expect("errorMessage" in (data ?? {})).toBe(false);
  });

  /**
   * Test 1b — Billed-redelivery (#1618 crash-window closure / hole ②)
   *
   * A task billed on a prior run whose Worker crashed between billing and
   * the Stage-4 node_history record. On redelivery the re-entry guard's
   * "already billed" branch re-emits the stored result AND (post-#1618)
   * re-records node_history exactly once — so a billed result is always
   * recoverable from history, no matter which failure path.
   *
   * RED before #1618: case (a) re-emits but never records → 0 history rows.
   */
  it("Test 1b: billed-redelivery re-records node_history exactly once (#1618 hole ②)", async () => {
    const nodeId = crypto.randomUUID();
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    // The crashed run left the node handling with a live lease at gen 1.
    await seedNode(hocuspocus, docName, nodeId, {
      name: "Redeliver Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, type: "backend", startedAt: Date.now(), gen: 1 },
      leaseGen: 1,
      attachments: [],
    });

    // A task already billed on the prior run (result persisted on the row),
    // but with NO node_history row yet (the crash was before Stage 4).
    const [taskRow] = await db.insert(schema.tasks).values({
      userId: FIXTURE_USER_ID,
      projectId: FIXTURE_PROJECT_ID,
      spaceId: FIXTURE_SPACE_ID,
      taskType: "image",
      mode: "append",
      source: "mini_tool",
      params: {},
      status: "completed",
      billedAt: new Date(),
      billedCredits: 3,
      creditsUsed: 3,
      result: { model: "resolved-model-t1b", cost: 0.05, outputs: [{ url: "https://oss/billed-redeliver.png", cover_url: "https://oss/thumb-1b.png" }] },
    }).returning();
    const taskId = taskRow!.id;

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
      nodeGens: { [nodeId]: 1 },
      mode: "append" as const,
    }, { attempts: 1 });

    // Wait for the case-(a) re-emit to reach the node (proof the redelivery
    // was processed) — gen 1 matches the live lease so it lands.
    await waitForCondition(
      async () => {
        const d = await readNodeData(hocuspocus, docName, nodeId);
        return d?.["content"] === "https://oss/billed-redeliver.png";
      },
      30_000,
      `case-a re-emit landed for ${taskId}`,
    );

    // The same billed-redelivery path re-records node_history exactly once.
    const rows = await db
      .select()
      .from(schema.nodeHistory)
      .where(eq(schema.nodeHistory.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.entryType).toBe("generation");
    expect(rows[0]!.content).toBe("https://oss/billed-redeliver.png");
    // #1618 ②: metadata parity — case a reads the resolved model from the
    // persisted task result, matching what Stage 4 would have recorded (not
    // the raw job payload / charged credits).
    expect((rows[0]!.metadata as { model?: string }).model).toBe("resolved-model-t1b");
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
    const nodeId = crypto.randomUUID();
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    providerCtrl.mode = "failure";
    providerCtrl.error = new Error("Synthetic AIGC provider error for test 2");

    // Seed with existing content — must remain untouched after failure
    await seedNode(hocuspocus, docName, nodeId, {
      name: "Failure Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, type: "frontend", startedAt: Date.now(), gen: 1 },
      leaseGen: 1,
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
    const taskId = taskRow!.id;

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
      nodeGens: { [nodeId]: 1 },
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
   * Test 2b — Retryable failure then success (#1580 adversarial fix:
   * "retryable close self-fences the retry")
   *
   * Attempt 1's provider call throws (retryable — attempts: 2), attempt 2
   * succeeds. The worker must NOT emit the failure lease-close on the
   * non-terminal attempt; the node keeps its live lease, so the successful
   * retry's done write-back passes the gen CAS and lands.
   *
   * Invariants:
   *   - node ends state=idle with the SUCCESS content (not stuck on error)
   *   - errorMessage is cleared (success write-back carries errorMessage:null)
   *   - handlingBy cleared
   */
  it("Test 2b: retryable failure then success — retry's result lands (no self-fencing)", async () => {
    const nodeId = crypto.randomUUID();
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);

    providerCtrl.mode = "fail-once";
    providerCtrl.calls = 0;
    providerCtrl.error = new Error("Synthetic transient provider error (attempt 1)");
    providerCtrl.outputs = [{
      url: "https://oss/result-t2b-retry.png",
      cover_url: "https://oss/thumb-t2b.png",
    }];

    await seedNode(hocuspocus, docName, nodeId, {
      name: "Retry Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, type: "frontend", startedAt: Date.now(), gen: 1 },
      leaseGen: 1,
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
    const taskId = taskRow!.id;

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
      nodeGens: { [nodeId]: 1 },
      mode: "append" as const,
      // 2 attempts with minimal backoff so the retry runs inside the test window.
    }, { attempts: 2, backoff: { type: "fixed" as const, delay: 100 } });

    await waitForCondition(
      async () => {
        const t = await taskService.getByIdInternal(taskId);
        return t?.status === "completed";
      },
      30_000,
      `task ${taskId} completed after retry`,
    );

    await waitForCondition(
      async () => {
        const data = await readNodeData(hocuspocus, docName, nodeId);
        return data?.["state"] === "idle" && data?.["content"] === "https://oss/result-t2b-retry.png";
      },
      30_000,
      `node ${nodeId} received the retry's content`,
    );

    const data = await readNodeData(hocuspocus, docName, nodeId);
    expect(data!["state"]).toBe("idle");
    expect(data!["content"]).toBe("https://oss/result-t2b-retry.png");
    // The success write-back must have cleared attempt-1's error (and no
    // close may have shipped on the non-terminal attempt at all).
    expect(data!["errorMessage"]).toBeUndefined();
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
    const nodeIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
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
        handlingBy: { userId: FIXTURE_USER_ID, type: "frontend", startedAt: Date.now(), gen: 1 },
        leaseGen: 1,
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
    const taskId = taskRow!.id;

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
      nodeGens: Object.fromEntries(nodeIds.map((id) => [id, 1])),
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
      expect(data!["coverUrl"]).toBe(providerCtrl.outputs[i]!.cover_url);
      expect("handlingBy" in (data ?? {})).toBe(false);
    }
  });

  // ── Asset-layer hardening (adversarial holes #4 / #1 / #2) ──────────────
  afterEach(() => {
    storageCtrl.failDownload = false;
    storageCtrl.contentKey = null;
  });

  /**
   * Drive one successful-provider generation end to end: seed the node,
   * insert the task row, and enqueue the job. Returns the task id so the
   * caller can await completion / inspect billing.
   * @param opts - Generation parameters.
   * @param opts.nodeId - Target canvas node id.
   * @param opts.url - Provider output URL.
   * @param opts.userId - Acting user (defaults to the studio-owning fixture).
   * @returns The inserted task's id.
   */
  async function runGeneration(opts: {
    nodeId: string;
    url: string;
    userId?: string;
  }): Promise<string> {
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
    const userId = opts.userId ?? FIXTURE_USER_ID;
    providerCtrl.mode = "success";
    providerCtrl.outputs = [{ url: opts.url, cover_url: "" }];
    await seedNode(hocuspocus, docName, opts.nodeId, {
      name: "Gen Node",
      state: "handling",
      handlingBy: { userId, type: "frontend", startedAt: Date.now(), gen: 1 },
      leaseGen: 1,
      attachments: [],
    });
    const [taskRow] = await db
      .insert(schema.tasks)
      .values({
        userId,
        projectId: FIXTURE_PROJECT_ID,
        spaceId: FIXTURE_SPACE_ID,
        taskType: "image",
        mode: "append",
        source: "mini_tool",
        params: {},
      })
      .returning();
    const taskId = taskRow!.id;
    await tasksQueue.add(
      "run-task",
      {
        taskId,
        taskType: "image",
        userId,
        projectId: FIXTURE_PROJECT_ID,
        spaceId: FIXTURE_SPACE_ID,
        source: "mini_tool",
        toolName: "remove-bg",
        params: {},
        targetNodeIds: [opts.nodeId],
        nodeGens: { [opts.nodeId]: 1 },
        mode: "append" as const,
      },
      { attempts: 1 },
    );
    return taskId;
  }

  it("Test 4 (asset #4): a primary-output re-host failure fails the task and does NOT bill", async () => {
    const nodeId = crypto.randomUUID();
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
    const tempUrl = "https://cdn.tmp/expiring-t4.png";
    storageCtrl.failDownload = true; // the re-host to permanent storage throws

    const taskId = await runGeneration({ nodeId, url: tempUrl });

    await waitForCondition(
      async () => {
        const t = await taskService.getByIdInternal(taskId);
        return t?.status === "failed";
      },
      30_000,
      `task ${taskId} failed on persist failure`,
    );

    // CRITICAL: a persist failure must NOT bill (user decision 2026-07-04).
    const [t] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    expect(t!.status).toBe("failed");
    expect(t!.billedAt).toBeNull();

    // The node ends idle with an error, NOT pointing at the expiring temp URL.
    // Wait on the NODE (not just the task row) — the failed event's Redis →
    // Collab → Yjs application lands after the task status flips.
    const data = await waitForNodeData(
      hocuspocus,
      docName,
      nodeId,
      (d) => d["state"] === "idle",
      10_000,
      `node ${nodeId} idle after persist failure`,
    );
    expect(typeof data["errorMessage"]).toBe("string");
    expect(data["content"]).not.toBe(tempUrl);
  });

  it("Test 5 (asset #1): a within-studio dedup hit collapses to one registry row; node keeps its own URL (reconcile deferred to #1609)", async () => {
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
    // Force both generations to hash to the same content (a genuine dedup).
    storageCtrl.contentKey = "asset-1-dedup-content";
    const nodeA = crypto.randomUUID();
    const nodeB = crypto.randomUUID();

    const urlA = "https://oss/dedup-first-t5.png";
    const taskA = await runGeneration({ nodeId: nodeA, url: urlA });
    await waitForCondition(
      async () => (await taskService.getByIdInternal(taskA))?.status === "completed",
      30_000,
      `task ${taskA} (first dedup gen) completed`,
    );
    const first = await waitForNodeData(
      hocuspocus,
      docName,
      nodeA,
      (d) => d["state"] === "idle",
      10_000,
      "first dedup node idle",
    );
    expect(first["content"]).toBe(urlA);

    // Second gen: same content hash, DIFFERENT provider URL → registry
    // dedups to the first row (usage counted once). The node keeps its OWN
    // url — the node-URL reconcile is deferred to the upload slice (#1609)
    // because reconciling could leak cross-project identifiers (adversarial
    // #5). This test locks the dedup-collapse + the "no reconcile" contract.
    const urlB = "https://oss/dedup-second-t5.png";
    const taskB = await runGeneration({ nodeId: nodeB, url: urlB });
    await waitForCondition(
      async () => (await taskService.getByIdInternal(taskB))?.status === "completed",
      30_000,
      `task ${taskB} (second dedup gen) completed`,
    );
    await waitForCondition(
      async () => {
        const d = await readNodeData(hocuspocus, docName, nodeB);
        return d?.["state"] === "idle" && typeof d?.["content"] === "string";
      },
      5_000,
      "second dedup node idle with content",
    );

    const second = await readNodeData(hocuspocus, docName, nodeB);
    expect(second!["content"]).toBe(urlB); // keeps its own URL (no reconcile)
    // Registry collapsed to exactly one row for the shared content hash.
    const rows = await db
      .select()
      .from(schema.studioAssets)
      .where(eq(schema.studioAssets.studioId, FIXTURE_STUDIO_ID));
    expect(rows.filter((r) => r.fileUrl === urlA).length).toBe(1);
    expect(rows.some((r) => r.fileUrl === urlB)).toBe(false);
  });

  it("Test 7 (asset #A HIGH): a sync-transport buffer output is NOT re-hosted by Case 2 (no fall-through / no fail on a Case-2 blip)", async () => {
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
    const nodeId = crypto.randomUUID();

    // Provider returns raw bytes (audio/tts) → Case 1 uploads them to
    // permanent storage. storageCtrl.failDownload makes any Case-2 re-host
    // throw. Pre-fix, Case 1's own (non-/uploads/) URL fell through into
    // Case 2 → the failing re-download marked the task failed. With the fix
    // Case 2 is skipped (storedFromBuffer), so the task COMPLETES.
    storageCtrl.failDownload = true;
    providerCtrl.mode = "buffer";

    await seedNode(hocuspocus, docName, nodeId, {
      name: "Buffer Node",
      state: "handling",
      handlingBy: { userId: FIXTURE_USER_ID, type: "frontend", startedAt: Date.now(), gen: 1 },
      leaseGen: 1,
      attachments: [],
    });
    const [taskRow] = await db
      .insert(schema.tasks)
      .values({
        userId: FIXTURE_USER_ID,
        projectId: FIXTURE_PROJECT_ID,
        spaceId: FIXTURE_SPACE_ID,
        taskType: "audio",
        mode: "append",
        source: "mini_tool",
        params: {},
      })
      .returning();
    const taskId = taskRow!.id;
    await tasksQueue.add(
      "run-task",
      {
        taskId,
        taskType: "audio",
        userId: FIXTURE_USER_ID,
        projectId: FIXTURE_PROJECT_ID,
        spaceId: FIXTURE_SPACE_ID,
        source: "mini_tool",
        toolName: "tts",
        params: {},
        targetNodeIds: [nodeId],
        nodeGens: { [nodeId]: 1 },
        mode: "append" as const,
      },
      { attempts: 1 },
    );

    await waitForCondition(
      async () => (await taskService.getByIdInternal(taskId))?.status === "completed",
      30_000,
      `task ${taskId} (buffer output) completed despite Case-2 failDownload`,
    );
    const data = await readNodeData(hocuspocus, docName, nodeId);
    expect(data!["state"]).toBe("idle");
    // Node points at the Case-1 permanent URL, never re-hosted by Case 2.
    expect(data!["content"]).toBe("https://oss/uploaded");
  });

  it("Test 6 (asset #2): a generation by a user with no personal studio completes best-effort but registers no asset", async () => {
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
    const nodeId = crypto.randomUUID();
    const url = "https://oss/nostudio-t6.png";

    // Acting user has NO personal studio → resolveOwnerStudioId throws →
    // registration is best-effort skipped. The job MUST still complete
    // (bytes stored + node updated) — best-effort must not fail the job.
    const taskId = await runGeneration({
      nodeId,
      url,
      userId: FIXTURE_USER_NO_STUDIO_ID,
    });

    await waitForCondition(
      async () => (await taskService.getByIdInternal(taskId))?.status === "completed",
      30_000,
      `task ${taskId} (no-studio user) completed best-effort`,
    );
    // Wait on the NODE, not just the task row (CI flake 2026-07-16: task
    // completed but the done event's Yjs application had not landed yet).
    const data = await waitForNodeData(
      hocuspocus,
      docName,
      nodeId,
      (d) => d["state"] === "idle",
      10_000,
      `node ${nodeId} idle (no-studio best-effort)`,
    );
    expect(data["content"]).toBe(url); // node still got its content

    // But the asset is UNTRACKED — no studio_assets row links to this task.
    const rows = await db
      .select()
      .from(schema.studioAssets)
      .where(eq(schema.studioAssets.generationTaskId, taskId));
    expect(rows.length).toBe(0);
  });

  it("Test 8 (asset #A round-3): a local-handler output that is already OUR OWN URL is not re-hosted by Case 2", async () => {
    const docName = canvasSpaceDocName(FIXTURE_PROJECT_ID, FIXTURE_SPACE_ID);
    const nodeId = crypto.randomUUID();

    // Simulate a local mini-tool (video cut/crop) that uploaded its output
    // to our storage and returned an OUR-OWN url. failDownload makes any
    // Case-2 re-download throw. Pre-round-3 the '/uploads/' guard did not
    // recognize our S3/OSS URL, so Case 2 fired and the failing re-download
    // failed the task; with adapter.isOwnUrl the re-host is skipped → the
    // task completes and the node keeps the already-stored URL.
    storageCtrl.failDownload = true;
    const taskId = await runGeneration({ nodeId, url: "https://oss/uploaded" });

    await waitForCondition(
      async () => (await taskService.getByIdInternal(taskId))?.status === "completed",
      30_000,
      `task ${taskId} (own-url output) completed without re-host`,
    );
    const data = await waitForNodeData(
      hocuspocus,
      docName,
      nodeId,
      (d) => d["state"] === "idle",
      10_000,
      `node ${nodeId} idle (own-url output)`,
    );
    expect(data["content"]).toBe("https://oss/uploaded");
  });
});
