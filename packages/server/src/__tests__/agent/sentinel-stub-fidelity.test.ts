// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The sentinels the domain stub hands out are the real ones.
 *
 * Most agent tests replace `@breatic/domain` wholesale, on purpose: loading
 * it for real drags in the model SDK. The stub therefore spells the
 * interaction sentinels out, and that copy has to stay equal to what the
 * tools actually produce — the agent loop recognises a tool result by
 * `startsWith`, and the turn tests feed it those literal strings. Let the
 * copy drift and the loop silently stops recognising anything: no widget is
 * raised, the payload goes to the model as ordinary text, and every one of
 * those tests still passes, because they are asserting against the same
 * drifted stub.
 *
 * This file is the one place that does not mock the module, so it can see
 * both values at once and hold them together.
 */
import { describe, it, expect } from "vitest";

import {
  ASK_USER_SENTINEL,
  ASK_USER_CHOICE_SENTINEL,
  PROPOSE_CANVAS_ACTION_SENTINEL,
  SHOW_SEARCH_RESULTS_SENTINEL,
} from "@breatic/domain";

import { domainMock } from "../helpers/mock-core.js";

/** Each stubbed sentinel against the value its tool really writes. */
const PAIRS: ReadonlyArray<{ name: string; real: string }> = [
  { name: "ASK_USER_SENTINEL", real: ASK_USER_SENTINEL },
  { name: "ASK_USER_CHOICE_SENTINEL", real: ASK_USER_CHOICE_SENTINEL },
  { name: "PROPOSE_CANVAS_ACTION_SENTINEL", real: PROPOSE_CANVAS_ACTION_SENTINEL },
  { name: "SHOW_SEARCH_RESULTS_SENTINEL", real: SHOW_SEARCH_RESULTS_SENTINEL },
];

describe("the domain stub's sentinels", () => {
  it.each(PAIRS)("$name matches the tool that writes it", ({ name, real }) => {
    const stubbed = (domainMock() as unknown as Record<string, unknown>)[name];
    expect(stubbed).toBe(real);
  });
});
