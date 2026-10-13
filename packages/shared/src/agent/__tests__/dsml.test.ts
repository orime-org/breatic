// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * DSML is the text DeepSeek writes a tool call in. When the provider cannot
 * parse it (the arguments inside were not valid JSON), the markup comes back
 * as reply text; the shapes below are the ones stored replies show.
 */
import { describe, it, expect } from "vitest";

import { dsmlBlockStart, dsmlHeldFrom, stripDsml } from "@shared/agent/dsml.js";

const PROSE = "Here's the plan: one portrait, then the storyboard.\n\n";

/** A call block whose last parameter is never closed, as in the 2026-10-13 reply. */
const UNCLOSED_BLOCK = [
  "<｜DSML｜tool_calls>",
  '<｜DSML｜invoke name="propose_canvas_action">',
  '<｜DSML｜parameter name="edges" string="false">[{"fromIndex": 0, "toIndex": 1}]</｜DSML｜parameter>',
  '<｜DSML｜parameter name="groupName" string="true">Storyboard</｜DSML｜parameter>',
  '<｜DSML｜parameter name="nodes" string="false">[{"prompt": "he shouts "here I come!" and"',
].join("\n");

/** The same block written again and again, the last copy cut off inside a closing tag, as in the 2026-10-07 reply. */
const REPEATED_BLOCKS = `${UNCLOSED_BLOCK}\n${UNCLOSED_BLOCK}]</｜DSML｜parameter\n`;

describe("stripDsml", () => {
  it("keeps the prose before a call block and drops the block to the end", () => {
    expect(stripDsml(`${PROSE}${UNCLOSED_BLOCK}`)).toBe(PROSE);
  });

  it("drops every repeated copy of the block", () => {
    expect(stripDsml(`${PROSE}${REPEATED_BLOCKS}`)).toBe(PROSE);
  });

  it("treats a function_calls opener the same as tool_calls", () => {
    expect(stripDsml(`${PROSE}<｜DSML｜function_calls>\n<｜DSML｜invoke name="x">`)).toBe(PROSE);
  });

  it("removes a lone tag written inside prose and keeps the words around it", () => {
    const text =
      'Add the <｜DSML｜parameter name="groupName">` line. I kept forgetting that parameter.\n\nNow it is in.';
    expect(stripDsml(text)).toBe("Add the ` line. I kept forgetting that parameter.\n\nNow it is in.");
  });

  it("removes a lone closing tag and one left unfinished at the end", () => {
    expect(stripDsml("before</｜DSML｜parameter> after <｜DSML｜invoke name=\"x")).toBe("before after ");
  });

  it("stops an unfinished tag at the end of its line", () => {
    expect(stripDsml('a <｜DSML｜parameter name="x"\nnext line')).toBe("a \nnext line");
  });

  it("leaves ordinary angle brackets and full-width bars alone", () => {
    const text = "if a < b and c > d, use ｜ as a divider: <b>bold</b> ｜DSML｜ is just a word here";
    expect(stripDsml(text)).toBe(text);
  });
});

describe("dsmlBlockStart", () => {
  it("finds where the call block starts", () => {
    expect(dsmlBlockStart(`${PROSE}${UNCLOSED_BLOCK}`)).toBe(PROSE.length);
  });

  it("answers -1 when there is no call block, even with a lone tag", () => {
    expect(dsmlBlockStart('see <｜DSML｜parameter name="x"> here')).toBe(-1);
  });
});

describe("dsmlHeldFrom", () => {
  it("holds a tail that could still become a tag", () => {
    expect(dsmlHeldFrom("Let me propose it.\n\n<｜DS")).toBe("Let me propose it.\n\n".length);
    expect(dsmlHeldFrom("text</")).toBe(4);
    expect(dsmlHeldFrom("text<")).toBe(4);
  });

  it("holds a tag that has started but not reached its >", () => {
    expect(dsmlHeldFrom('text<｜DSML｜parameter name="gro')).toBe(4);
    expect(dsmlHeldFrom("text<｜DSML｜tool_ca")).toBe(4);
  });

  it("holds nothing once the tail cannot be a tag", () => {
    expect(dsmlHeldFrom("a < b")).toBe(5);
    expect(dsmlHeldFrom("<b>bold</b>")).toBe(11);
    expect(dsmlHeldFrom('done <｜DSML｜parameter name="x">')).toBe(31);
    expect(dsmlHeldFrom('<｜DSML｜parameter name="x"\nnext')).toBe(30);
  });
});
