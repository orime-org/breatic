// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each tool of a turn is handed (inner#1315): every tool keeps the
 * turn's usage recorder, the save gets the server's storing, and the proposal
 * check gets the studio whose material counts.
 */

import { describe, it, expect } from "vitest";
import { openDocumentOf, turnToolsContext } from "@server/agent/turn-tools-context.js";

const usage = { recordServiceCall: () => undefined, recordModelCall: () => undefined } as never;
const saveToStorage = async () => ({ url: "u", mimeType: "image/png", width: 1, height: 1 });
const tools = {
  web_search: {},
  save_image: {},
  propose_canvas_action: {},
  propose_document_edit: {},
  search_conversations: {},
  read_conversation: {},
  read_node_history: {},
  list_project_activity: {},
};
const records = { spaceName: () => undefined } as never;

describe("turnToolsContext", () => {
  const openDocument = { spaceId: "d1", spaceName: "Storyboard", blocks: [] };
  const context = turnToolsContext(tools, usage, { saveToStorage, studioId: "s1", openDocument, records });

  it("keeps the usage recorder on every tool", () => {
    for (const name of Object.keys(tools)) expect(context[name]).toMatchObject({ usage });
  });

  it("hands the save its storing", () => {
    expect(context.save_image).toMatchObject({ usage, saveToStorage });
  });

  it("hands the proposal check the studio", () => {
    expect(context.propose_canvas_action).toMatchObject({ usage, studioId: "s1" });
  });

  it("hands the document proposal the open document", () => {
    expect(context.propose_document_edit).toMatchObject({ usage, openDocument });
  });

  it("hands the four record tools the turn's records", () => {
    for (const name of ["search_conversations", "read_conversation", "read_node_history", "list_project_activity"]) {
      expect(context[name]).toEqual({ usage, records });
    }
  });

  it("gives other tools nothing more", () => {
    expect(Object.keys(context.web_search ?? {})).toEqual(["usage"]);
  });
});

describe("openDocumentOf", () => {
  const blocks = [{ id: "b1", type: "paragraph", text: "x", lossy: false, partial: false }];
  const base = { id: "d1", name: "Storyboard", kind: "document" as const };

  it("is the loaded document the reader has open, with its blocks", () => {
    expect(
      openDocumentOf({ current_space: { ...base, state: "loaded", content: "<!-- b:1 -->\nx", total_chars: 14, blocks } }),
    ).toEqual({ spaceId: "d1", spaceName: "Storyboard", blocks });
  });

  it("is null when no Space is open, the open one is still loading, or it is not a document", () => {
    expect(openDocumentOf({})).toBeNull();
    expect(openDocumentOf({ current_space: { ...base, state: "loading" } })).toBeNull();
    const detail = {
      selected_total: 0,
      selected_attached: 0,
      selected_whole: 0,
      slim: false,
      texts_cut: 0,
      names_only: 0,
      edges_not_listed: 0,
      nodes_not_listed: 0,
      groups_not_listed: 0,
    };
    expect(
      openDocumentOf({ current_space: { ...base, kind: "canvas", state: "loaded", content: "{}", total_chars: 2, detail } }),
    ).toBeNull();
  });
});
