// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect } from "vitest";
import { getAgentConfig } from "@breatic/core";

import { agentModelIds } from "@domain/credit/priced-models.js";

describe("the models the agent's own paths run on (#1363)", () => {
  it("are every model the user can pick and the consolidation model, each once", () => {
    const config = getAgentConfig();
    expect(agentModelIds().sort()).toEqual(
      [...new Set([...config.chat_models.map((m) => m.id), config.consolidation_model])].sort(),
    );
    // The shipped picker lists three models, and consolidation runs on one of
    // them, so a list that dropped the picker would come out shorter.
    expect(agentModelIds()).toHaveLength(3);
  });
});
