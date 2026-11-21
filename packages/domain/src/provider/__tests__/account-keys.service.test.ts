// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Whether a model the payer pointed at an upstream is still bound there (inner#1953). */

import { beforeAll, describe, expect, it } from "vitest";
import { initCore } from "@breatic/core";
import { initProvider, provider } from "../instance.js";
import { choiceHolds } from "../account-keys.service.js";

beforeAll(() => {
  initCore({ ...process.env });
  initProvider();
});

describe("choiceHolds", () => {
  it("holds for a model bound on the upstream", () => {
    const [model, bindings] = Object.entries(provider().config.models)[0]!;
    expect(choiceHolds(model, bindings[0]!.upstream)).toBe(true);
  });

  it("holds for no model the configuration does not name, whatever its name", () => {
    for (const name of ["constructor", "__proto__", "toString", "valueOf", "nope"]) {
      expect(choiceHolds(name, "fal"), name).toBe(false);
    }
  });
});
