// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A web-animation Messages plan made on an account's own keys (inner#1953): only the upstreams the account holds a key
 * for that take Messages, recorded as the account's, and never the deployment's keys in their place.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountKeyFailure } from "../../errors.js";
import type { KeySet } from "../../keys.js";
import { llmProvider, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

/**
 * An account's key set.
 * @param keys - Its keys by upstream.
 * @returns The set.
 */
const account = (keys: Record<string, string>): KeySet => ({ owner: "account", keyOf: (upstream) => keys[upstream] });

describe("messagesPlan on an account's keys", () => {
  it("lists only the upstreams the account holds a key for, and records the plan as the account's", () => {
    const plan = llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4.1-flash-1017", undefined, account({ openrouter: "sk-or-v1-acct" }));
    expect(plan.keysOwner).toBe("account");
    expect(plan.candidates.map((c) => c.upstream)).toEqual(["openrouter"]);
    expect(JSON.stringify(plan)).not.toContain("sk-or-v1-acct");
  });

  it("fails as account_key_missing when the account holds a key for no upstream that takes Messages", () => {
    const thrown = (() => {
      try {
        llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4.1-flash-1017", undefined, account({ fal: "fal-acct" }));
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(AccountKeyFailure);
    expect((thrown as AccountKeyFailure).kind).toBe("account_key_missing");
  });

  it("records nothing on the deployment's keys", () => {
    const deployment: KeySet = { owner: "deployment", keyOf: () => undefined };
    expect(llmProvider(fakes, {}).llm.messagesPlan("deepseek/deepseek-v4.1-flash-1017", undefined, deployment)).not.toHaveProperty("keysOwner");
  });
});
