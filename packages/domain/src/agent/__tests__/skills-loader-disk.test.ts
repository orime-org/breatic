// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The registry reads real files, and these are the only tests that let it.
 *
 * Every other test in this package replaces `getSkillRegistry` with a fixture,
 * which is right for testing what the callers do with a skill — and leaves the
 * code that turns a directory into a skill with no coverage at all. Two things
 * live only there: the line that reads a skill's declared model out of
 * metadata.json, which is the sole production wiring of "a skill fixes the
 * model it runs on", and the gate that decides which skills the model is even
 * told about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CoreModule from "@breatic/core";
import type { SkillMeta } from "@breatic/shared";
import { SkillRegistry } from "@domain/agent/skills-loader.js";

/** Routing the fake registry's skills are judged against. Set per test. */
let routing: Record<string, Record<string, unknown>> = {};

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getSkillRouting: () => ({ skills: routing }),
  };
});

let dir = "";

/**
 * Write one skill to disk, the way the repo lays them out.
 * @param name - The name its frontmatter declares.
 * @param metadata - What its metadata.json holds, if anything.
 * @param directory - The directory name, when it differs from the skill name.
 */
function writeSkill(
  name: string,
  metadata?: Record<string, unknown>,
  directory?: string,
): void {
  const skillDir = join(dir, directory ?? name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "what ${name} does"\n---\n\n# ${name}\n\nbody\n`,
  );
  if (metadata) {
    writeFileSync(join(skillDir, "metadata.json"), JSON.stringify(metadata));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-"));
  routing = {};
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loading skills off disk", () => {
  it("carries a declared model onto the skill", () => {
    // The one production path from metadata.json to `InternalSkillMeta.model`.
    // Everything downstream of it is tested against fixtures that simply
    // assert the field, so without this the field could stop being read and
    // every one of those would stay green.
    writeSkill("picky", { model: "vendor/pinned-model", tools: [] });
    expect(new SkillRegistry(dir).getInternal("picky")?.model).toBe(
      "vendor/pinned-model",
    );
  });

  it("leaves the model unset when the skill names none", () => {
    writeSkill("plain", { tools: [] });
    expect(new SkillRegistry(dir).getInternal("plain")?.model).toBeUndefined();
  });

  it("ignores a model that is not a string", () => {
    writeSkill("odd", { model: 42, tools: [] });
    expect(new SkillRegistry(dir).getInternal("odd")?.model).toBeUndefined();
  });

  it("keys a skill by the name it declares, not by its directory", () => {
    // The registry, the gate and the routing config all key on the declared
    // name. A directory that disagrees is a shape this repo has carried.
    writeSkill("declared-name", { tools: [] }, "some-directory");
    const registry = new SkillRegistry(dir);
    expect(registry.get("declared-name")).toBeDefined();
    expect(registry.get("some-directory")).toBeUndefined();
  });

  it("keeps the model off the shape a route may hand to a client", () => {
    // Equality, not absence. A cast satisfies the compiler while handing the
    // whole internal object out, so listing what may leave is the only way to
    // stop the next internal field from leaking by omission.
    writeSkill("picky", { model: "vendor/pinned-model", tools: ["web_search"] });
    const publicMeta = new SkillRegistry(dir).get("picky");
    expect(Object.keys(publicMeta ?? {}).sort()).toEqual([
      "category",
      "description",
      "keywords",
      "name",
      "outputType",
      "tools",
    ]);
  });

  it("declares no model on the shared type either", () => {
    // The type half of the same rule, checked where a compiler can see it:
    // `SkillMeta` is what `GET /skills` returns and what the browser imports.
    const publicKeys: Record<keyof SkillMeta, true> = {
      name: true,
      description: true,
      category: true,
      tools: true,
      outputType: true,
      keywords: true,
    };
    // If `model` were added to SkillMeta, this object would stop satisfying
    // `Record<keyof SkillMeta, true>` and typecheck would fail here.
    expect(Object.keys(publicKeys)).not.toContain("model");
  });
});

describe("which skills the model is told about", () => {
  it("lists only the ones the routing config lets it reach for", () => {
    // `model_invocable` is one of the three axes the routing config
    // introduced, and this is its only production consumer.
    writeSkill("offered", { tools: [] });
    writeSkill("withheld", { tools: [] });
    routing = {
      offered: { surfaces: ["chat"], user_invocable: true, model_invocable: true },
      withheld: { surfaces: ["chat"], user_invocable: true, model_invocable: false },
    };
    const xml = new SkillRegistry(dir).buildSummaryXml();
    expect(xml).toContain('name="offered"');
    expect(xml).not.toContain('name="withheld"');
  });

  it("withholds a skill the config does not mention at all", () => {
    // Silence grants nothing, on this axis as on the others.
    writeSkill("unlisted", { tools: [] });
    expect(new SkillRegistry(dir).buildSummaryXml()).not.toContain(
      'name="unlisted"',
    );
  });

  it("carries each offered skill's description, which is what the model picks on", () => {
    writeSkill("offered", { tools: [] });
    routing = {
      offered: { surfaces: ["chat"], user_invocable: true, model_invocable: true },
    };
    expect(new SkillRegistry(dir).buildSummaryXml()).toContain(
      "what offered does",
    );
  });
});
