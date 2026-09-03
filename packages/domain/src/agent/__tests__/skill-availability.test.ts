// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pinning a skill's model has a cost, and this is it: no key for that
 * model's provider and the whole skill is dead.
 *
 * Every provider key defaults to `""` so a self-hosted deployment can
 * configure only the ones it wants. That is deliberate and stays. What it
 * produced before this was: the process starts fine, the skill lists fine,
 * and the user finds out by clicking — with whatever the underlying library
 * threw, which names endpoints and key hints.
 *
 * Text and media reach a key by completely different routes, which is why
 * one function has to know both:
 *
 * Text models fall back. `getModel` tries the direct provider and otherwise
 * routes through OpenRouter, so a skill on `google/gemini-*` runs fine with
 * no Google key as long as OpenRouter has one.
 *
 * Media models fall back too, but sideways: one model names several
 * providers with priorities, and any one of their keys will do. The key
 * NAMES are read from each modality's `providers.yaml` rather than listed
 * here, because that file holds names no env schema knows about.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import { AppError, initCore } from "@breatic/core";
import { loadLocales } from "@breatic/core";

// `t()` echoes the key back when no catalog is loaded, so without this
// the assertions below would measure a key name rather than the
// sentence a user reads. `server/src/index.ts` does the same at boot.
loadLocales();
import {
  assertSkillModelRunnable,
  checkSkillModelRunnable,
} from "@domain/agent/skill-availability.js";

const keys: Record<string, string> = {};

/**
 * Two skills that differ only in whether their model can be reached. The
 * model name is written out rather than referencing MEDIA_MODEL below: this
 * block is hoisted above it by the mock factory.
 */
const SKILLS: Record<string, Record<string, unknown>> = {
  unreachable: { name: "unreachable", description: "d", tools: [], model: "kling-o3-pro" },
  reachable: { name: "reachable", description: "d", tools: [], model: "anthropic/claude-sonnet-4-6" },
};

vi.mock("@domain/agent/skills-loader.js", () => ({
  getSkillRegistry: () => ({
    get: (name: string) => SKILLS[name],
    getInternal: (name: string) => SKILLS[name],
    loadSkillContent: () => "body",
  }),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    // `getRawEnvVar`, not the `env` proxy. The proxy resolves against the
    // validated config, which holds only the schema's keys — and a provider's
    // key name comes off a yaml file that is free to name one the schema has
    // never heard of. `KLING_ACCESS_KEY` is exactly that: providers.yaml
    // declares it, the schema declares KLINGAI_ACCESS_KEY, and reading it
    // through the proxy yields undefined however the process was started.
    getRawEnvVar: (name: string) => keys[name],
    // Both fixtures are permitted, so the only thing left that can refuse
    // them is the availability check — which is what these tests are about.
    getSkillRouting: () => ({
      skills: {
        unreachable: { surfaces: ["chat"], user_invocable: true, model_invocable: true },
        reachable: { surfaces: ["chat"], user_invocable: true, model_invocable: true },
      },
    }),
  };
});

/**
 * A media model that really is in the catalog, and the env vars its two
 * providers declare in config/models/video/providers.yaml.
 *
 * Named rather than read back from the check's own output: an earlier
 * version of these tests asserted only that SOMETHING was missing, which the
 * text fallback path satisfies just as well — deleting the entire media
 * branch left all eight green. Naming a key the text path can never produce
 * is what makes these two tests about media at all.
 */
const MEDIA_MODEL = "kling-o3-pro";
const KLINGAI_KEY = "KLING_ACCESS_KEY";
const WAVESPEED_KEY = "WAVESPEED_API_KEY";

beforeAll(() => {
  initCore(process.env);
});

// The yaml the check reads is cached, but that cache holds file contents,
// not key state — every test here varies only the environment.
beforeEach(() => {
  for (const k of Object.keys(keys)) delete keys[k];
});

describe("whether a skill's model can actually run", () => {
  it("says yes when a skill names no model at all", () => {
    // Most skills do not care which model runs them. Nothing to check.
    expect(checkSkillModelRunnable(undefined).ok).toBe(true);
  });

  it("says yes for a text model whose direct key is set", () => {
    keys.ANTHROPIC_API_KEY = "sk-ant";
    keys.OPENROUTER_API_KEY = "";
    expect(checkSkillModelRunnable("anthropic/claude-sonnet-4-6").ok).toBe(true);
  });

  it("says yes for a DeepSeek model whose own key is set", () => {
    // The default model this build calls is a DeepSeek one, so a deployment
    // holding only that key has to read as runnable. Before the direct route
    // existed, `deepseek/` matched no prefix and the answer came from the
    // OpenRouter fallback alone.
    keys.DEEPSEEK_API_KEY = "sk-ds";
    keys.OPENROUTER_API_KEY = "";
    expect(checkSkillModelRunnable("deepseek/deepseek-v4-pro").ok).toBe(true);
  });

  it("names the DeepSeek key among the ways to fix an unreachable one", () => {
    keys.DEEPSEEK_API_KEY = "";
    keys.OPENROUTER_API_KEY = "";
    const result = checkSkillModelRunnable("deepseek/deepseek-v4-pro");
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("DEEPSEEK_API_KEY");
    expect(result.missing).toContain("OPENROUTER_API_KEY");
  });

  it("says yes for a text model with no direct key but an OpenRouter one", () => {
    // The fallback is the whole reason text is different from media.
    keys.GOOGLE_API_KEY = "";
    keys.OPENROUTER_API_KEY = "sk-or";
    expect(checkSkillModelRunnable("google/gemini-2.5-flash").ok).toBe(true);
  });

  it("says no, and names what is missing, when no text key is set at all", () => {
    keys.GOOGLE_API_KEY = "";
    keys.OPENROUTER_API_KEY = "";
    const result = checkSkillModelRunnable("google/gemini-2.5-flash");
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("OPENROUTER_API_KEY");
    expect(result.missing).toContain("GOOGLE_API_KEY");
  });

  it("says no for a media model, naming every provider key that would fix it", () => {
    keys.OPENROUTER_API_KEY = "sk-or";  // text route fine; the media one is not
    const result = checkSkillModelRunnable(MEDIA_MODEL);
    expect(result.ok).toBe(false);
    // Both of the model's providers, read off providers.yaml. Note
    // KLING_ACCESS_KEY: it is not in the env schema, which is exactly why
    // the names have to come from that file rather than a list in code.
    expect([...result.missing].sort()).toEqual([KLINGAI_KEY, WAVESPEED_KEY].sort());
    // And an OpenRouter key does not save a media model, however text-like
    // the model name looks.
    expect(result.missing).not.toContain("OPENROUTER_API_KEY");
  });

  it("says yes for a media model once its provider AND the text route are set", () => {
    // The lower-priority provider, so this cannot pass by only ever
    // consulting the first entry. The text key too: both consumers hand the
    // resolved model to `getModel`, which carries every request whatever the
    // modality, so a media key alone is not enough to run anything.
    keys[WAVESPEED_KEY] = "configured";
    keys.OPENROUTER_API_KEY = "sk-or";
    expect(checkSkillModelRunnable(MEDIA_MODEL).ok).toBe(true);
  });

  it("still says no for a media model with only the text route set", () => {
    keys.ANTHROPIC_API_KEY = "sk-ant";
    keys.OPENROUTER_API_KEY = "sk-or";
    const result = checkSkillModelRunnable(MEDIA_MODEL);
    expect(result.ok).toBe(false);
    expect([...result.missing].sort()).toEqual([KLINGAI_KEY, WAVESPEED_KEY].sort());
  });

  it("still says no for a media model with only its provider set", () => {
    keys[WAVESPEED_KEY] = "configured";
    const result = checkSkillModelRunnable(MEDIA_MODEL);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("OPENROUTER_API_KEY");
  });

  it("throws a typed error rather than letting the library fail", () => {
    keys.GOOGLE_API_KEY = "";
    keys.OPENROUTER_API_KEY = "";
    // The client gets a status and a sentence, not a provider stack trace.
    // A plain Error would come back as a 500 — the error handler matches on
    // `instanceof AppError`.
    let thrown: unknown;
    try {
      assertSkillModelRunnable("picky", "google/gemini-2.5-flash");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(503);
    expect((thrown as Error).message).toContain("picky");
  });

  it("keeps the deployment's env var names out of what the user is shown", () => {
    // The error handler returns `AppError.message` verbatim to the caller,
    // so anything named here lands on the screen of whoever clicked. The
    // names belong in `missing`, for the layer that knows where its logs go.
    keys.GOOGLE_API_KEY = "";
    keys.OPENROUTER_API_KEY = "";
    let thrown: unknown;
    try {
      assertSkillModelRunnable("picky", "google/gemini-2.5-flash");
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as Error).message;
    for (const name of ["OPENROUTER_API_KEY", "GOOGLE_API_KEY", "API_KEY"]) {
      expect(message).not.toContain(name);
    }
    // Still knowable by the caller, which is the point of returning them.
    expect(checkSkillModelRunnable("google/gemini-2.5-flash").missing).toContain(
      "OPENROUTER_API_KEY",
    );
  });

  it("does not throw for a skill whose model is runnable", () => {
    keys.ANTHROPIC_API_KEY = "sk-ant";
    expect(() =>
      assertSkillModelRunnable("fine", "anthropic/claude-sonnet-4-6"),
    ).not.toThrow();
  });
});

// Everything above tests the judgement. These test that anything actually
// asks it — a check nothing calls is a check that does not exist, and both
// call sites are one deleted line away from that.
describe("who asks it", () => {
  it("the factory refuses to assemble a run on an unreachable model", async () => {
    const { buildAgentConfig } = await import("@domain/agent/agent-config.js");
    expect(() => buildAgentConfig({ skillName: "unreachable" })).toThrow(
      /is not available on this server/,
    );
  });

  it("the factory assembles one whose model is reachable", async () => {
    keys.ANTHROPIC_API_KEY = "sk-ant";
    const { buildAgentConfig } = await import("@domain/agent/agent-config.js");
    expect(buildAgentConfig({ skillName: "reachable" }).modelId).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  it("the gate refuses before a request gets any further", async () => {
    const { assertSkillUsable } = await import("@domain/agent/skill-gate.js");
    expect(() => assertSkillUsable("unreachable", "chat")).toThrow(
      /is not available on this server/,
    );
  });

  it("the gate lets through a skill whose model is reachable", async () => {
    keys.ANTHROPIC_API_KEY = "sk-ant";
    const { assertSkillUsable } = await import("@domain/agent/skill-gate.js");
    expect(() => assertSkillUsable("reachable", "chat")).not.toThrow();
  });
});
