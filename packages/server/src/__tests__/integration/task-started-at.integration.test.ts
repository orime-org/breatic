// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A task row keeps the moment it first started running.
 *
 * The worker picks one run up many times: a retry after a failure, and a
 * container job coming back for its next read. Each pickup marks the row
 * running again, and the run's duration counts from `started_at`.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import { taskService } from "@breatic/domain";

initCore(process.env);

let sql: ReturnType<typeof postgres>;
let taskId: string;
const RUN = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "task-started-at-test-driver" },
  });
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`started-at-${RUN}@example.com`}, true) RETURNING id
  `;
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (user_id, space_id, task_type, mode)
    VALUES (${user!.id}, ${crypto.randomUUID()}, 'video', 'overwrite')
    RETURNING id
  `;
  taskId = task!.id;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

describe("marking a task running", () => {
  // The start is the worker's clock, the clock the run's end and duration are read on.
  it("keeps the first start the worker gave, when the run is picked up again", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");

    const started = await taskService.markRunning(taskId, "job-1", first);
    const again = await taskService.markRunning(taskId, "job-1", new Date("2026-01-01T00:05:00.000Z"));

    const [row] = await sql<{ started_at: Date }[]>`SELECT started_at FROM tasks WHERE id = ${taskId}`;
    expect(started.getTime()).toBe(first.getTime());
    expect(again.getTime()).toBe(first.getTime());
    expect(row!.started_at.getTime()).toBe(first.getTime());
  });
});
