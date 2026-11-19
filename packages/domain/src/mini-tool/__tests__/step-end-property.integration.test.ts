// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 §11.7: in any order of sends, answers, thrown errors and ends, followed by the run's end (which abandons
 * every unresolved step): every step a send went out for has its consumption, no step is unresolved once the run
 * ends, and each billed answer is counted once.
 */

import crypto from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore } from "@breatic/core";
import {
  appendMiniToolStepDeliveredCosts, endMiniToolModelStep, listUnresolvedMiniToolModelSteps, markStepSending, storeStepTicket,
} from "@domain/index.js";

const DEADLINE = 4070908800000;
const STEPS = 3;
let pg: ReturnType<typeof createPgClient>;

/** One thing that happens to a step: its usd is a distinct billed answer. */
type Command =
  | { kind: "send"; step: number }
  | { kind: "running"; step: number }
  | { kind: "thrown"; step: number; usd: number }
  | { kind: "returned"; step: number; usd: number }
  | { kind: "failed"; step: number; usd: number };

beforeAll(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "1", PAYMENT_ENABLED: "false" });
  pg = createPgClient(inject("DATABASE_URL"), { name: "step-end-property", max: 3 });
});
afterAll(async () => { await pg.end(); });

/**
 * Seed a running execution with model steps, by SQL.
 * @returns The task and its steps.
 * @throws {Error} When fixture SQL fails.
 */
async function seed(): Promise<{ taskId: string; stepIds: string[] }> {
  const taskId = crypto.randomUUID(); const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID(); const projectId = crypto.randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`prop-${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`s-${studioId}`},'team','Prop')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`p-${projectId}`},'Prop')`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result)
    VALUES (${taskId},${userId},${projectId},${crypto.randomUUID()},'mini_tool_execution','append','mini_tool','running',
      ${pg.json({ deadlineAt: DEADLINE })},${pg.json({})})`;
  const stepIds: string[] = [];
  for (let i = 0; i < STEPS; i += 1) {
    const stepId = crypto.randomUUID(); stepIds.push(stepId);
    await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output)
      VALUES (${stepId},${taskId},${i},'generate','bria-video-eraser-mask','pending',${pg.json({})})`;
  }
  return { taskId, stepIds };
}

const step = fc.integer({ min: 0, max: STEPS - 1 });
const usd = fc.integer({ min: 1, max: 1000 }).map((n) => n / 1000);
const command: fc.Arbitrary<Command> = fc.oneof(
  step.map((s) => ({ kind: "send" as const, step: s })),
  step.map((s) => ({ kind: "running" as const, step: s })),
  fc.record({ kind: fc.constant("thrown" as const), step, usd }),
  fc.record({ kind: fc.constant("returned" as const), step, usd }),
  fc.record({ kind: fc.constant("failed" as const), step, usd }),
);

describe("model steps under any order of events and the run's end", () => {
  it("leave every sent step with its consumption, none unresolved, and every billed answer counted once", async () => {
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 12 }), fc.integer({ min: 1, max: 1000 }).map((n) => n / 1000), async (commands, abandonUsd) => {
      const f = await seed();
      const sent = new Set<number>(); const ended = new Set<number>(); const versions = new Map<number, number>();
      let billed = 0;
      for (const c of commands) {
        const stepId = f.stepIds[c.step]!;
        if (ended.has(c.step)) {
          // An ended step takes no further event; a late end is kept out by the first.
          if (c.kind === "returned" || c.kind === "failed") {
            await endMiniToolModelStep({ taskId: f.taskId, stepId, end: { kind: "failed", category: "failed", error: { code: "late" } }, costs: [], servedBy: "wavespeed" });
          }
          continue;
        }
        const version = (versions.get(c.step) ?? 0) + 1; versions.set(c.step, version);
        if (c.kind === "send") {
          await storeStepTicket(f.taskId, stepId, { version, phase: "send" });
          await markStepSending(f.taskId, stepId, DEADLINE); sent.add(c.step);
        } else if (c.kind === "running") {
          if (!sent.has(c.step)) continue;
          await storeStepTicket(f.taskId, stepId, { version, phase: "running" });
        } else if (c.kind === "thrown") {
          if (!sent.has(c.step)) continue;
          await appendMiniToolStepDeliveredCosts(f.taskId, stepId, [{ state: "known", usd: c.usd, source: "billing" }]); billed += c.usd;
        } else {
          if (!sent.has(c.step)) continue;
          const end = c.kind === "returned" ? { kind: "returned" as const, link: "https://out.example/r.mp4" } : { kind: "failed" as const, category: "failed" as const, error: { code: "failed" } };
          await endMiniToolModelStep({ taskId: f.taskId, stepId, end, costs: [{ state: "known", usd: c.usd, source: "billing" }], servedBy: "wavespeed" });
          billed += c.usd; ended.add(c.step);
        }
      }
      // The run's end: every unresolved step is abandoned, and the abandon's billed answer ends it.
      for (const unresolved of await listUnresolvedMiniToolModelSteps(f.taskId)) {
        await endMiniToolModelStep({ taskId: f.taskId, stepId: unresolved.stepId, end: { kind: "failed", category: "failed", error: { code: "abandoned" } }, costs: [{ state: "known", usd: abandonUsd, source: "billing" }], servedBy: "wavespeed" });
        billed += abandonUsd;
      }
      expect(await listUnresolvedMiniToolModelSteps(f.taskId)).toEqual([]);
      const rows = await pg<{ position: number; output: { miniToolConsumption?: { known: number } } }[]>`SELECT position,output FROM task_upstream_steps WHERE task_id=${f.taskId}`;
      for (const s of sent) expect(rows.find((r) => r.position === s)?.output.miniToolConsumption).toBeDefined();
      const counted = rows.reduce((sum, r) => sum + (r.output.miniToolConsumption?.known ?? 0), 0);
      expect(counted).toBeCloseTo(billed, 9);
    }), { numRuns: 40 });
  });
});
