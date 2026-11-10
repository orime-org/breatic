// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
  understand_media: {},
  save_image: {},
  propose_canvas_action: {},
  propose_document_edit: {},
  search_conversations: {},
  read_conversation: {},
  read_node_history: {},
  list_project_activity: {},
  save_memory: {},
  delete_memory: {},
  read_memory: {},
};
const records = { spaceName: () => undefined } as never;
const memory = { read: async () => [] } as never;

describe("turnToolsContext", () => {
  const openDocument = { spaceId: "d1", spaceName: "Storyboard", blocks: [] };
  const readPages = async () => ({ pages: [], usage: { wallMs: 0, cpuUsec: null } });
  const context = turnToolsContext(tools, usage, { saveToStorage, studioId: "s1", openDocument, records, memory, readPages });

  it("keeps the usage recorder on every tool", () => {
    for (const name of Object.keys(tools)) expect(context[name]).toMatchObject({ usage });
  });

  it("hands the save its storing", () => {
    expect(context.save_image).toMatchObject({ usage, saveToStorage });
  });

  it("hands media understanding the same canonical storage capability", () => {
    expect(context.understand_media).toMatchObject({ usage, saveToStorage, studioId: "s1" });
    expect(context.understand_media?.resolveCanonicalMediaSource).toEqual(expect.any(Function));
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

  it("hands the three memory tools the turn's memory (#1363)", () => {
    for (const name of ["save_memory", "delete_memory", "read_memory"]) {
      expect(context[name]).toEqual({ usage, memory });
    }
  });

  it("gives other tools nothing more", () => {
    expect(Object.keys(context.web_search ?? {})).toEqual(["usage"]);
  });
});

describe("turnToolsContext for web_fetch (inner#1664)", () => {
  const readPages = async () => ({ pages: [], usage: { wallMs: 0, cpuUsec: null } });
  // Held in a variable, not written inline: the turn argument gains
  // `readPages` with the implementation, and an inline literal would not
  // compile against the argument as it is declared today.
  const turn = { saveToStorage, studioId: "s1", openDocument: null, records, memory, readPages };
  const context = turnToolsContext({ web_search: {}, web_fetch: {} }, usage, turn);

  it("hands web_fetch the turn's page read beside its usage recorder", () => {
    expect(context.web_fetch).toEqual({ usage, readPages });
  });

  it("gives web_search nothing more than its usage recorder", () => {
    expect(context.web_search).toEqual({ usage });
  });
});

describe("openDocumentOf", () => {
  const blocks = [{ id: "b1", type: "paragraph", text: "x", lossy: false, partial: false }];
  const base = { id: "d1", name: "Storyboard", kind: "document" as const };

  it("is the loaded document the user has open, with its blocks", () => {
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
