// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { NODE_TASK_ACTIONS } from "@shared/types/node-task.js";

describe("what a task row's first line names", () => {
  // inner#856: a transcription's row says so, apart from an understanding's.
  it("names a transcription apart from an understanding", () => {
    expect([...NODE_TASK_ACTIONS]).toEqual(["upload", "generate", "understand", "mini_tool", "transcribe"]);
  });
});
