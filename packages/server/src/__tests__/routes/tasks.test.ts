// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tasks route tests — list, get, canvas task creation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";
// The real constant, from the source rather than the barrel: this file
// mocks `@breatic/domain`, and a value typed out here again would be a
// second copy of the very thing the assertions are checking against.
import { UNDERSTAND_PINS } from "../../../../domain/src/understand/types.js";

import * as domain from "@breatic/domain";
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";

// The run-once routes need a key per press; the Redis double in mock-core
// answers every claim as a first press, so one key serves the whole file.
const AUTH = {
  Cookie: "breatic_session=valid-token",
  "Content-Type": "application/json",
  "Idempotency-Key": "test-press",
};

describe("Tasks routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectService.assertAccess.mockResolvedValue(undefined);
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
    mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: true });
  });

  describe("GET /tasks — list", () => {
    it("returns task list", async () => {
      mocks.taskService.list.mockResolvedValue([
        { id: "task-1", taskType: "image", status: "completed" },
      ]);

      const app = createApp();
      const res = await app.request("/api/v1/tasks?limit=10&offset=0", { headers: AUTH });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /tasks/:id — get", () => {
    it("returns a single task", async () => {
      mocks.taskService.get.mockResolvedValue({
        id: "task-1", taskType: "image", status: "completed", userId: "user-1",
      });

      const app = createApp();
      const res = await app.request("/api/v1/tasks/task-1", { headers: AUTH });

      expect(res.status).toBe(200);
    });
  });

  // v10: every canvas task is project + Space scoped (worker writes
  // back to `project-{pid}/canvas-{spaceId}`). Both UUIDs are required.
  const PID = "11111111-1111-4111-8111-111111111111";
  const SID = "22222222-2222-4222-9222-222222222222";

  describe("POST /canvas/tasks — create canvas task", () => {
    it("creates task and returns 201", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { prompt: "a cat" },
          model: "test-model",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { task_id: string } };
      expect(body.data.task_id).toBe("task-1");
    });

    it("rejects without auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(401);
    });

    it("rejects with 402 when the balance is below the estimate — no task row created (#1580 #7 pre-check)", async () => {
      mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 0, held: 0 });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {},
          model: "test-model",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(402);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
    });

    it("holds the balance to the estimate of the run the request describes", async () => {
      // 100 spendable, and the run as described prices at 150.
      vi.mocked(domain.estimateTaskCredits).mockResolvedValueOnce(150);
      mocks.creditHoldService.reserveCredits.mockImplementation(async (r: { amount: number }) =>
        r.amount <= 100 ? { ok: true } : { ok: false, studioId: "s1", spendable: 100, held: 0 },
      );
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "video",
          params: { duration: 10, prompt: "<p>a slow pan</p>" },
          model: "test-model",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(402);
      expect(domain.estimateTaskCredits).toHaveBeenCalledWith(
        "test-model",
        { params: { duration: 10, prompt: "<p>a slow pan</p>" }, prompt: "a slow pan" },
      );
      expect(mocks.taskService.create).not.toHaveBeenCalled();
    });

    it("rejects an i2i/edit model with no source image BEFORE enqueue (#1675) — no task, no bill", async () => {
      // The model needs a source image but params.images is empty. The gate
      // must fire before taskService.create + enqueue (billing is post-worker),
      // so nothing is created / queued / billed.
      mocks.violatesSourceRequirementForModel.mockReturnValue(true);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: {}, // no images
          model: "nano-banana-pro-edit",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("allows an i2i model that carries a source image (#1675 gate passes)", async () => {
      mocks.violatesSourceRequirementForModel.mockReturnValue(false);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { images: ["https://cdn/x.png"] },
          model: "nano-banana-pro-edit",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.taskService.create).toHaveBeenCalled();
    });

    it("rejects a submission with too many reference images BEFORE enqueue (#1735) — no task, no bill", async () => {
      // The submission over-fills a capped list param; the gate must fire
      // before taskService.create + enqueue so nothing is created / queued /
      // billed (the worker would otherwise silently truncate the extras).
      mocks.violatesReferenceCountForModel.mockReturnValue({
        field: "images",
        limit: 14,
        actual: 15,
      });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { images: Array.from({ length: 15 }, (_, i) => `https://cdn/${i}.png`) },
          model: "nano-banana-pro-edit",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("allows a submission within the reference-image cap (#1735 gate passes)", async () => {
      mocks.violatesReferenceCountForModel.mockReturnValue(null);
      const app = createApp();
      const res = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          task_type: "image",
          params: { images: ["https://cdn/x.png", "https://cdn/y.png"] },
          model: "nano-banana-pro-edit",
          source: "task",
          project_id: PID,
          space_id: SID,
          mode: "append",
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.taskService.create).toHaveBeenCalled();
    });

    it("accepts a second overwrite onto a node that already has one running (#186)", async () => {
      // A node carries several tasks at once now. Both are enqueued and both
      // reach an end of their own; whichever result the user keeps is decided
      // on the node's task list, not by refusing the second request.
      const nodeId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const app = createApp();
      const body = JSON.stringify({
        task_type: "image",
        params: {},
        model: "test-model",
        source: "task",
        project_id: PID,
        space_id: SID,
        mode: "overwrite",
        target_node_id: nodeId,
      });

      const first = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body,
      });
      const second = await app.request("/api/v1/canvas/tasks", {
        method: "POST",
        headers: AUTH,
        body,
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    });

    describe("credit hold (inner#1611)", () => {
      const NODE = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const BODY = JSON.stringify({
        task_type: "image",
        params: { prompt: "a cat" },
        model: "test-model",
        source: "task",
        project_id: PID,
        space_id: SID,
        mode: "overwrite",
        target_node_id: NODE,
      });

      /**
       * Send the run.
       * @returns The response.
       */
      async function send(): Promise<Response> {
        return createApp().request("/api/v1/canvas/tasks", { method: "POST", headers: AUTH, body: BODY });
      }

      /**
       * The key the admission held under.
       * @returns It.
       */
      function heldKey(): string {
        const call = mocks.creditHoldService.reserveCredits.mock.calls[0]?.[0] as { referenceId: string } | undefined;
        if (!call) throw new Error("nothing was held");
        return call.referenceId;
      }

      it("holds the estimate under the id the task row is then created with", async () => {
        vi.mocked(domain.estimateTaskCredits).mockResolvedValueOnce(12);
        const res = await send();
        expect(res.status).toBe(201);
        expect(mocks.creditHoldService.reserveCredits).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: PID, actorUserId: "user-1", amount: 12, ttlMs: expect.any(Number) }),
        );
        expect(mocks.taskService.create.mock.calls[0]?.[8]).toBe(heldKey());
        expect(mocks.creditHoldService.releaseHold).not.toHaveBeenCalled();
      });

      it("releases the hold when the storage gate refuses after admission", async () => {
        mocks.assertStorageAllowance.mockRejectedValueOnce(Object.assign(new Error("full"), { statusCode: 403 }));
        await send();
        expect(mocks.creditHoldService.releaseHold).toHaveBeenCalledWith(heldKey());
        expect(mocks.taskService.create).not.toHaveBeenCalled();
      });

      it("releases the hold when the node's row cannot be opened", async () => {
        mocks.nodeTaskService.open.mockRejectedValueOnce(new Error("collab down"));
        const res = await send();
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(mocks.creditHoldService.releaseHold).toHaveBeenCalledWith(heldKey());
        expect(mockQueueAdd).not.toHaveBeenCalled();
      });

      it("releases the hold when the job cannot be queued", async () => {
        mockQueueAdd.mockRejectedValueOnce(new Error("redis down"));
        const res = await send();
        expect(res.status).toBe(500);
        expect(mocks.creditHoldService.releaseHold).toHaveBeenCalledWith(heldKey());
      });

      it("keeps the hold of a queued run whose job id cannot be recorded", async () => {
        mocks.taskService.setJobId.mockRejectedValueOnce(new Error("db down"));
        await send();
        expect(mockQueueAdd).toHaveBeenCalled();
        expect(mocks.creditHoldService.releaseHold).not.toHaveBeenCalled();
      });

      it("creates nothing when the admission is refused", async () => {
        mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 0, held: 0 });
        const res = await send();
        expect(res.status).toBe(402);
        expect(mocks.taskService.create).not.toHaveBeenCalled();
        expect(mocks.creditHoldService.releaseHold).not.toHaveBeenCalled();
      });
    });

  });

  describe("POST /canvas/node-history/snapshot", () => {
    // A text node's words live in the canvas document, and a history row is
    // the only copy of them that survives the next edit. This is the browser's
    // one way to write one, so the endpoint validates what it is handed and
    // asks the same question every write to a project asks.
    it("records what the node holds right now", async () => {
      mocks.nodeHistoryService.recordSnapshot.mockResolvedValue({ id: "h-9" });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/node-history/snapshot", {
        method: "POST",
        headers: AUTH,
        // The row is written against a project and a node. Nothing here reads
        // a Space, and `node_history` has no column for one.
        body: JSON.stringify({
          project_id: PID,
          node_id: "11111111-1111-4111-8111-111111111111",
          text: "A red bicycle against a brick wall.",
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(
        PID,
        expect.any(String),
        "editor",
      );
      expect(mocks.nodeHistoryService.recordSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PID,
          nodeId: "11111111-1111-4111-8111-111111111111",
          content: "A red bicycle against a brick wall.",
        }),
      );
    });

    // A snapshot of nothing is not one: the row would show the reader a
    // blank line they cannot tell apart from any other. The browser greys
    // the item out on a node saying nothing; this is the same rule where it
    // is authoritative.
    it("refuses a snapshot of nothing", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/node-history/snapshot", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          node_id: "11111111-1111-4111-8111-111111111111",
          text: "",
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.nodeHistoryService.recordSnapshot).not.toHaveBeenCalled();
    });

    it("refuses a node id that is not one", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/node-history/snapshot", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          node_id: "not-a-uuid",
          text: "x",
        }),
      });

      expect(res.status).toBe(422);
    });
  });

  // The node a reading writes to, which the browser built and named before
  // asking. It is an id of ours, the way every node on a canvas is.
  const READ_INTO = "33333333-3333-4333-8333-333333333333";

  describe("POST /canvas/understand — what a refusal leaves behind", () => {
    // The node's row is opened before the credit gate so a refusal has
    // somewhere to be said. That order leaves this route holding two rows,
    // and a refusal has to finish both — a task left `pending` is one no
    // worker will ever touch and no sweep will ever end.
    it("ends the task it created when the balance is short", async () => {
      mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 0, held: 0 });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          space_id: SID,
          source_type: "image",
          source_url: "https://assets.invalid/image/a.png",
          node_ids: ["11111111-1111-4111-8111-111111111111"],
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.taskService.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        "no_credits",
      );
    });

    // Once a row is open, the row is the answer: it holds the cause and the
    // node shows it. Saying 402 as well would leave the browser guessing at
    // something only this route knows — whether a row exists — and a 500
    // raised before the row opened looks exactly like one raised after.
    it("answers with the row's own state once a row is open", async () => {
      mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 0, held: 0 });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          space_id: SID,
          source_type: "image",
          source_url: "https://assets.invalid/image/a.png",
          node_ids: ["11111111-1111-4111-8111-111111111111"],
        }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        data: { task_id: expect.any(String), status: "failed" },
      });
    });
  });

  // The reader's language is known at one end only — the browser — and the
  // sentence it decides is written at the other, by the model. This route
  // carries it between them without reading it.
  it("carries the reader's locale through to the job", async () => {
    const app = createApp();
    await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
        reader_locale: "ja",
      }),
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({ reader_locale: "ja" }),
      }),
      expect.anything(),
    );
  });

  // The label is what the reader sees naming this run in the node's task
  // list, and the two other writers of that column put the model or the tool
  // there — a proper noun, the same in every language. A reading is a model
  // call like any other, so it names the model it pins.
  it("names the row after the model the reading pins", async () => {
    const app = createApp();
    await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
      }),
    });

    expect(mocks.nodeTaskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ label: UNDERSTAND_PINS.model }),
    );
  });

  // The same fact, one step further on: the history row this run writes
  // carries the model it ran on, the way every other modality's row does.
  it("sends the pinned model to the worker", async () => {
    const app = createApp();
    await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
      }),
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: UNDERSTAND_PINS.model }),
      expect.anything(),
    );
  });

  // A reading answers with one piece of text, so it writes to the one node the
  // press built. Naming more opens a row per name — each an insert, a count
  // and a publish — before the credit gate, for nodes no answer is coming to.
  it("refuses a call naming more nodes than a reading writes to", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO, "44444444-4444-4444-8444-444444444444"],
      }),
    });

    expect(res.status).toBe(422);
    expect(mocks.nodeTaskService.open).not.toHaveBeenCalled();
  });

  // A throttle that never refuses in a test is a throttle nobody has watched
  // work: this is the refusal itself, and what it leaves behind — nothing.
  it("opens no row for a press the throttle refused", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    const app = createApp();
    const res = await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
      }),
    });

    expect(res.status).toBe(429);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
    expect(mocks.nodeTaskService.open).not.toHaveBeenCalled();
  });

  // One call opens a row per node named and puts a model call behind it, and
  // it opens those rows before the credit gate — by design, so a refusal has
  // somewhere to be said. That order is what makes the throttle this route's
  // own: both of its neighbours that write on a press carry one.
  it("asks the throttle before it writes anything", async () => {
    const app = createApp();
    await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
      }),
    });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), [
      { key: expect.stringContaining("understand:"), max: expect.any(Number), windowSeconds: expect.any(Number) },
    ]);
  });

  // What one press leaves on the new node while the reading runs: a single
  // task, counted and published to the canvas so the node shows it beside
  // the words it is about to hold. It lands on the node the browser built
  // and on no other — that node is the whole of what this run is about.
  it("counts one running task on the node the browser built", async () => {
    const app = createApp();
    await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
      }),
    });

    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledTimes(1);
    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(SID),
      READ_INTO,
      { running: 1, done: 0, failed: 0, expired: 0 },
      undefined,
    );
  });

  // `tasks.source` is one column with one vocabulary, and every lane that
  // opens a task names itself in it. A lane that names nothing falls to the
  // column's own default, which is a word from before that vocabulary
  // existed — so the rows this lane writes would be the only ones the
  // vocabulary cannot account for.
  it("names this lane in the column every lane names itself in", async () => {
    const app = createApp();
    await app.request("/api/v1/canvas/understand", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: PID,
        space_id: SID,
        source_type: "image",
        source_url: "https://cdn/x.png",
        node_ids: [READ_INTO],
      }),
    });

    expect(mocks.taskService.create).toHaveBeenCalledWith(
      expect.anything(),
      PID,
      SID,
      "understand",
      "append",
      expect.anything(),
      expect.anything(),
      "understand",
    );
  });

  // inner#856: a transcription is a reading with its own action, question
  // and switch; it lands in the same lane and on the same row machinery.
  describe("POST /canvas/transcribe", () => {
    const TRANSCRIBE = {
      project_id: PID,
      space_id: SID,
      source_type: "audio",
      source_url: "https://cdn/x.m4a",
      node_ids: [READ_INTO],
      keep_fillers: false,
      reader_locale: "zh-TW",
    };

    /**
     * Send one transcription press.
     * @param body - The request body.
     * @returns The response.
     */
    const press = async (body: Record<string, unknown>): Promise<Response> =>
      await createApp().request("/api/v1/canvas/transcribe", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify(body),
      });

    it("opens a transcription row named after the pinned model", async () => {
      const res = await press(TRANSCRIBE);
      expect(res.status).toBe(201);
      expect(mocks.nodeTaskService.open).toHaveBeenCalledWith(
        expect.objectContaining({ action: "transcribe", label: UNDERSTAND_PINS.model }),
      );
    });

    it("queues a reading that asks for a transcription", async () => {
      await press(TRANSCRIBE);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          taskType: "understand",
          source: "understand",
          params: expect.objectContaining({
            reading: "transcribe",
            keep_fillers: false,
            reader_locale: "zh-TW",
            source_type: "audio",
          }),
        }),
        expect.anything(),
      );
      expect(mocks.taskService.create).toHaveBeenCalledWith(
        expect.anything(),
        PID,
        SID,
        "understand",
        "append",
        expect.objectContaining({ reading: "transcribe" }),
        UNDERSTAND_PINS.model,
        "understand",
      );
    });

    it("asks its own throttle", async () => {
      await press(TRANSCRIBE);
      expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), [
        { key: expect.stringContaining("transcribe:"), max: expect.any(Number), windowSeconds: expect.any(Number) },
      ]);
    });

    it.each([
      ["a picture", { ...TRANSCRIBE, source_type: "image" }],
      ["no filler switch", { ...TRANSCRIBE, keep_fillers: undefined }],
      ["two nodes", { ...TRANSCRIBE, node_ids: [READ_INTO, READ_INTO] }],
    ])("refuses %s", async (_name, body) => {
      const res = await press(body);
      expect(res.status).toBe(422);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("POST /canvas/understand — a refused run still has a row", () => {
    // The node is on the canvas before this request goes out, so a refusal
    // has somewhere to be said: the row this run opened is settled `failed`
    // with the cause, and the node shows failed=1 (downstream-node-creation
    // decision, stage 4). A toast with no row behind it would leave a node
    // sitting there with nothing to explain it.
    it("settles the row it opened when the balance is short", async () => {
      mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 0, held: 0 });
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          source_type: "image",
          source_url: "https://cdn/x.png",
          node_ids: [READ_INTO],
          project_id: PID,
          space_id: SID,
        }),
      });

      expect(res.status).toBe(201);
      expect(mocks.nodeTaskService.open).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: READ_INTO }),
      );
      expect(mocks.nodeTaskService.settle).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", errorMessage: "no_credits" }),
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    // Queueing is the point of no return: past it a worker will pick the job
    // up, read the media and bill for it. The job's id is recorded for
    // whoever has to find that job by hand — no code reads it — so a run
    // whose id went unrecorded still runs, and marking it failed would put
    // "failed" on a node the reader
    // then watches produce a reading, and bill them for it.
    it("leaves a queued run running when its job id cannot be recorded", async () => {
      mocks.taskService.setJobId.mockRejectedValueOnce(new Error("db down"));
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          space_id: SID,
          source_type: "image",
          source_url: "https://cdn/x.png",
          node_ids: [READ_INTO],
        }),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        data: { task_id: expect.any(String), status: "pending" },
      });
      expect(mocks.taskService.markFailed).not.toHaveBeenCalled();
      expect(mocks.nodeTaskService.settle).not.toHaveBeenCalled();
    });

    it("holds the estimate under the task's id and releases it when the job cannot be queued (inner#1611)", async () => {
      mockQueueAdd.mockRejectedValueOnce(new Error("redis down"));
      const app = createApp();
      await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          project_id: PID,
          space_id: SID,
          source_type: "image",
          source_url: "https://cdn/x.png",
          node_ids: [READ_INTO],
        }),
      });

      const held = mocks.creditHoldService.reserveCredits.mock.calls[0]?.[0] as { referenceId: string } | undefined;
      expect(held?.referenceId).toEqual(expect.any(String));
      expect(mocks.creditHoldService.releaseHold).toHaveBeenCalledWith(held?.referenceId);
      expect(mocks.taskService.markFailed).toHaveBeenCalledWith(held?.referenceId, "internal");
    });

    // A row on the node is the only thing that carries a cause back to the
    // canvas, so a run that names no node is refused before anything is
    // created: it would bill and answer into nowhere while the reader
    // watches a node that never changes.
    it("refuses a run that named no node", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          source_type: "image",
          source_url: "https://cdn/x.png",
          project_id: PID,
          space_id: SID,
        }),
      });

      expect(res.status).toBe(422);
      expect(mocks.taskService.create).not.toHaveBeenCalled();
      expect(mocks.nodeTaskService.open).not.toHaveBeenCalled();
    });

    // The task row is written before the node's row is opened, so opening
    // that row is one more way out that has to end the first: a task left
    // `pending` is one no worker will pick up and no sweep will end, and the
    // reader is told by the rejection, there being no row to hold the cause.
    it("does not leave the task pending when the node's row cannot be opened", async () => {
      mocks.nodeTaskService.open.mockRejectedValueOnce(new Error("collab down"));
      const app = createApp();
      const res = await app.request("/api/v1/canvas/understand", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          source_type: "image",
          source_url: "https://cdn/x.png",
          node_ids: [READ_INTO],
          project_id: PID,
          space_id: SID,
        }),
      });

      expect(res.status).toBe(503);
      expect(mocks.taskService.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        "internal",
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("GET /canvas/nodes/:nodeId/history", () => {
    it("returns node history as { data: { entries, total } } (#1619 envelope)", async () => {
      const entry = { id: "h-1", entryType: "generation", status: "success" };
      // Mock the SERVICE's real shape ({ entries, total }); the route reads
      // result.entries, so a stale { data, total } mock would silently make
      // entries undefined and still pass a status-only assertion.
      mocks.nodeHistoryService.listByNode.mockResolvedValue({
        entries: [entry],
        total: 1,
      });

      const app = createApp();
      const res = await app.request(
        "/api/v1/canvas/nodes/b0000000-0000-4000-8000-000000000002/history?project_id=a0000000-0000-4000-8000-000000000001&limit=10&offset=0",
        { headers: AUTH },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { entries: [entry], total: 1 } });
    });

    it("422 for a non-uuid nodeId (canvas node ids are uuids)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/canvas/nodes/not-a-uuid/history?project_id=a0000000-0000-4000-8000-000000000001",
        { headers: AUTH },
      );
      expect(res.status).toBe(422);
    });
  });
});
