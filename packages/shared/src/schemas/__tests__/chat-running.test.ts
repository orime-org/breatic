// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The query for `GET /chat/running` (#1394): one project, named by its uuid.
 * Imported from the main entry, because the server and web resolve it there.
 */

import { describe, it, expect } from "vitest";

import { chatRunningQuerySchema } from "@shared/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("chatRunningQuerySchema", () => {
  it("accepts a project uuid and keeps it as given", () => {
    expect(chatRunningQuerySchema.parse({ project_id: projectId })).toEqual({ project_id: projectId });
  });

  it("refuses a query with no project", () => {
    expect(chatRunningQuerySchema.safeParse({}).success).toBe(false);
  });

  it("refuses a project that is not a uuid", () => {
    expect(chatRunningQuerySchema.safeParse({ project_id: "not-a-uuid" }).success).toBe(false);
  });

  it("drops a user id the query tries to name, so only the caller's own leases can be asked for", () => {
    const parsed = chatRunningQuerySchema.parse({
      project_id: projectId,
      user_id: "33333333-3333-4333-8333-333333333333",
    });

    expect(parsed).toEqual({ project_id: projectId });
  });
});
