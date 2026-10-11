// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each tool of a turn is handed (inner#1315): every tool keeps the
 * turn's usage recorder, the save gets the server's storing, and the proposal
 * check gets the studio whose material counts.
 */

import { describe, it, expect } from "vitest";
import { turnToolsContext } from "@server/agent/turn-tools-context.js";

const usage = { recordServiceCall: () => undefined, recordModelCall: () => undefined } as never;
const saveToStorage = async () => ({ url: "u", mimeType: "image/png", width: 1, height: 1 });
const tools = { web_search: {}, save_image: {}, propose_canvas_action: {} };

describe("turnToolsContext", () => {
  const context = turnToolsContext(tools, usage, { saveToStorage, studioId: "s1" });

  it("keeps the usage recorder on every tool", () => {
    for (const name of Object.keys(tools)) expect(context[name]).toMatchObject({ usage });
  });

  it("hands the save its storing", () => {
    expect(context.save_image).toMatchObject({ usage, saveToStorage });
  });

  it("hands the proposal check the studio", () => {
    expect(context.propose_canvas_action).toMatchObject({ usage, studioId: "s1" });
  });

  it("gives other tools nothing more", () => {
    expect(Object.keys(context.web_search ?? {})).toEqual(["usage"]);
  });
});
