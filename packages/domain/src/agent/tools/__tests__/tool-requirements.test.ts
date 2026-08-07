// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A tool whose configuration is missing never reaches the model.
 *
 * Found by running the product, not the suite. A smoke run on a deployment
 * without a search key had the model call web_search over and over until the
 * step ceiling stopped it, and reply nothing at all: the tool returned the
 * string "Error: ... not configured", the model read that as a result rather
 * than a refusal, and tried again. Every unit test was green throughout.
 *
 * Returning an error string is what makes it a loop. The model cannot tell a
 * failed call from a call whose answer happens to describe a failure, so it
 * does the reasonable thing and retries. The fix is not a better message --
 * it is that a tool which cannot work is not offered.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initCore } from "@breatic/core";
import type * as CoreModule from "@breatic/core";
import { buildToolSet } from "@domain/agent/tools/index.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const overrides: Record<string, string> = {};
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop: string) =>
        prop in overrides ? overrides[prop] : Reflect.get(target, prop),
    }),
    __setEnv: (k: string, v: string) => {
      overrides[k] = v;
    },
  };
});

beforeAll(() => {
  initCore(process.env);
});

/** Set one env value for the duration of a test. */
async function withEnv(key: string, value: string) {
  const core = (await import("@breatic/core")) as unknown as {
    __setEnv: (k: string, v: string) => void;
  };
  core.__setEnv(key, value);
}

describe("tools that need configuration", () => {
  it("leaves web_search out when its key is missing", async () => {
    await withEnv("BRAVE_SEARCH_API_KEY", "");
    expect(buildToolSet(["web_search"])).toEqual({});
  });

  it("includes web_search once its key is set", async () => {
    await withEnv("BRAVE_SEARCH_API_KEY", "brave-key");
    expect(Object.keys(buildToolSet(["web_search"]))).toEqual(["web_search"]);
  });

  it("does not drop the other tools along with it", async () => {
    // The failure mode this guards against is over-filtering: a search key
    // missing on a deployment must not cost that deployment its chat tools.
    await withEnv("BRAVE_SEARCH_API_KEY", "");
    const tools = buildToolSet([
      "web_search",
      "web_fetch",
      "ask_user_question",
    ]);
    expect(Object.keys(tools).sort()).toEqual(["ask_user_question", "web_fetch"]);
  });

  it("keeps tools that need no configuration", async () => {
    await withEnv("BRAVE_SEARCH_API_KEY", "");
    expect(Object.keys(buildToolSet(["web_fetch"]))).toEqual(["web_fetch"]);
  });

  it("skips a name it does not know rather than failing the whole assembly", async () => {
    // A stale name in a skill's metadata — one of the tools this PR deleted,
    // say — must cost that skill the tool and nothing else. Throwing here
    // would take down every run of every skill that carries the typo.
    await withEnv("BRAVE_SEARCH_API_KEY", "brave-key");
    expect(buildToolSet(["no_such_tool"])).toEqual({});
    expect(Object.keys(buildToolSet(["no_such_tool", "web_search"]))).toEqual([
      "web_search",
    ]);
  });
});
