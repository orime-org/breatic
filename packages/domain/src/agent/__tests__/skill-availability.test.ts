// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pinning a skill's model has a cost, and this is it: no key for that
 * model's provider and the whole skill is dead.
 *
 * Twelve provider keys all default to `""` so a self-hosted deployment can
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
import {
  assertSkillModelRunnable,
  checkSkillModelRunnable,
} from "@domain/agent/skill-availability.js";

const keys: Record<string, string> = {};

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, p: string) => (p in keys ? keys[p] : Reflect.get(t, p)),
    }),
  };
});

/** A media model that really is in the catalog, with its real provider. */
const MEDIA_MODEL = "kling-o3-pro";

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

  it("says no for a media model when none of its providers has a key", () => {
    const result = checkSkillModelRunnable(MEDIA_MODEL);
    expect(result.ok).toBe(false);
    // The names come off providers.yaml, so this asserts something was
    // found rather than a hardcoded guess at which key it is.
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("says yes for a media model as soon as one provider has a key", () => {
    const { missing } = checkSkillModelRunnable(MEDIA_MODEL);
    const firstKey = missing[0] ?? "";
    keys[firstKey] = "configured";
    expect(checkSkillModelRunnable(MEDIA_MODEL).ok).toBe(true);
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
    expect((thrown as Error).message).toContain("OPENROUTER_API_KEY");
  });

  it("does not throw for a skill whose model is runnable", () => {
    keys.ANTHROPIC_API_KEY = "sk-ant";
    expect(() =>
      assertSkillModelRunnable("fine", "anthropic/claude-sonnet-4-6"),
    ).not.toThrow();
  });
});
