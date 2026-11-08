// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The product guide is read a section at a time (breatic#1361).
 *
 * The whole guide is too long to carry into a turn every time the agent needs
 * one answer from it, so the tool's description holds an index -- every
 * section, grouped by Space -- and a call names the sections it wants. A call
 * is held to a size read from `config/agent.yaml`, each section stays short
 * enough to read alone in every language, and no section points at another by
 * where it sits ("above", "below", "next section"), since the one it points at
 * may not have been read.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Core from "@breatic/core";
import { SpaceTypeSchema } from "@breatic/shared";

/** The per-call cap the current test runs under; undefined runs under the deployment's own. */
const config = vi.hoisted(() => ({ cap: undefined as number | undefined }));

/** What `config/agent.yaml` really sets, read before any test overrides it. */
const deployed = vi.hoisted((): { value: unknown } => ({ value: undefined }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  return {
    ...actual,
    getAgentConfig: () => {
      const real = actual.getAgentConfig();
      deployed.value = (real as Record<string, unknown>)["product_guide_max_chars_per_call"];
      return config.cap === undefined ? real : { ...real, product_guide_max_chars_per_call: config.cap };
    },
  };
});

const { getAgentConfig, loadLocales, runWithLocale } = await import("@breatic/core");
const { productGuide, renderProductGuide } = await import("@domain/agent/tools/product-guide.js");

/** The sentence that opens what the agent knows of the guide. */
const PREAMBLE = "You are talking to someone who can edit this project";

/** Every locale the product ships. */
const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"];

/** How long one section may run in any language. */
const SECTION_MAX_CHARS = 24_000;

/**
 * The sections each Space type has in the guide. A Space type added without
 * a row here fails, so a new Space cannot ship with nothing in the guide.
 */
const SPACE_SECTIONS: Record<string, readonly string[]> = {
  canvas: [
    "Making nodes",
    "Filling a node",
    "Node menus",
    "Notes",
    "Moving around the canvas",
    "Generating",
    "Inside the generation panel",
    "Source slots",
    "Connections",
    "Mini-tools",
    "Focus crops",
    "Mentions",
    "Groups and undo",
    "Proposal cards",
  ],
  document: ["Document spaces", "Document proposal cards"],
  timeline: ["Timeline spaces"],
  "3d": ["3D spaces"],
};

beforeAll(() => {
  loadLocales();
});

beforeEach(() => {
  config.cap = undefined;
});

/**
 * Every section of the guide, by heading, with its text, as the render-all
 * function lays the guide out.
 * @returns Each heading and the section's text, heading line included.
 */
function sections(): { name: string; text: string }[] {
  return renderProductGuide()
    .split(/\n(?=## )/)
    .filter((part) => part.startsWith("## "))
    .map((part) => ({ name: (part.split("\n")[0] ?? "").slice(3), text: part }));
}

/**
 * The text of one section, without its heading line.
 * @param name - The heading.
 * @returns The section's body.
 */
function body(name: string): string {
  const found = sections().find((one) => one.name === name);
  if (found === undefined) throw new Error(`no section "${name}"`);
  return found.text.split("\n").slice(1).join("\n").trim();
}

/**
 * Call the tool the way the SDK does.
 * @param input - What the agent sends.
 * @returns What it answers.
 */
async function read(input: unknown): Promise<string> {
  const { execute } = productGuide as unknown as { execute: (input: unknown, options: object) => Promise<string> };
  return execute(input, {});
}

/**
 * The tool's description, its hard wraps folded.
 * @returns The description.
 */
function described(): string {
  const description: unknown = productGuide.description;
  return typeof description === "string" ? description.replace(/\s+/g, " ") : "";
}

/**
 * Every number a message states, thousands separators read through.
 * @param message - The message.
 * @returns The numbers, in order.
 */
function numbersIn(message: string): number[] {
  return [...message.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, "")));
}

describe("the call names the sections it wants", () => {
  it("takes a list of section names", () => {
    const schema = productGuide.inputSchema as unknown as { safeParse: (input: unknown) => { success: boolean } };
    expect(schema.safeParse({ sections: ["Proposal cards"] }).success).toBe(true);
    expect(schema.safeParse({ sections: ["Proposal cards", "Source slots"] }).success).toBe(true);
  });

  it("returns the section asked for and no other", async () => {
    const said = await read({ sections: ["Proposal cards"] });
    expect(said).toContain(body("Proposal cards"));
    for (const { name } of sections()) if (name !== "Proposal cards") expect(said, name).not.toContain(`## ${name}`);
  });

  it("returns every section asked for, and only those", async () => {
    const asked = ["Source slots", "Timeline spaces"];
    const said = await read({ sections: asked });
    for (const name of asked) expect(said, name).toContain(body(name));
    for (const { name } of sections()) if (!asked.includes(name)) expect(said, name).not.toContain(`## ${name}`);
  });

  it("gives each section alone, in the user's language, for every section of the guide", async () => {
    for (const { name } of sections()) {
      const said = await runWithLocale("zh-CN", () => read({ sections: [name] }));
      expect(said, name).toContain(runWithLocale("zh-CN", () => body(name)));
      for (const other of sections()) if (other.name !== name) expect(said, `${name} holds ${other.name}`).not.toContain(`## ${other.name}`);
    }
  });

  it("refuses a name the index does not have, listing every name it does", async () => {
    const refused = read({ sections: ["Proposal cards", "The secret panel"] });
    await expect(refused).rejects.toThrow(/The secret panel/);
    const message = await refused.catch((err: unknown) => (err instanceof Error ? err.message : ""));
    for (const { name } of sections()) expect(message, name).toContain(name);
  });
});

describe("the size of one call", () => {
  it("is capped at 48,000 characters in config/agent.yaml", () => {
    getAgentConfig();
    expect(deployed.value).toBe(48_000);
  });

  it("refuses a call whose sections run past the cap, stating the cap and how much was asked for", async () => {
    const asked = ["Proposal cards", "Inside the generation panel"];
    config.cap = 10_000_000;
    const size = (await read({ sections: asked })).length;
    config.cap = 999;
    const refused = read({ sections: asked });
    await expect(refused).rejects.toThrow();
    const stated = numbersIn(await refused.catch((err: unknown) => (err instanceof Error ? err.message : "")));
    expect(stated).toContain(999);
    // The size asked for, give or take the lines that join the sections.
    expect(stated.some((n) => Math.abs(n - size) <= 200), `${stated.join(", ")} against ${String(size)}`).toBe(true);
  });

  it("answers a call within the cap", async () => {
    config.cap = 999_999;
    await expect(read({ sections: ["Notes"] })).resolves.toContain(body("Notes"));
  });
});

describe("every section stands alone", () => {
  it("runs to at most 24,000 characters in every language", () => {
    for (const locale of LOCALES) {
      for (const { name, text } of runWithLocale(locale, sections)) {
        expect(text.length, `${locale} "${name}"`).toBeLessThanOrEqual(SECTION_MAX_CHARS);
      }
    }
  });

  it("never points elsewhere in the guide by where it sits, only by a section's name", () => {
    // Where a control sits on screen ("the strip above the prompt") is what
    // the user sees and stays; what is caught is a pointer to other text of
    // the guide, which a section read alone does not have.
    const POINTER = new RegExp(
      [
        /\b(?:next|previous) section\b/.source,
        /\(see\b[^()]*\b(?:above|below)\b[^()]*\)/.source,
        /\([^()]*\b(?:above|below)\)/.source,
        /\b(?:as|in the list) (?:above|below)\b/.source,
      ].join("|"),
      "gi",
    );
    const found = [...renderProductGuide().matchAll(POINTER)].map((m) => m[0]);
    expect(found).toEqual([]);
  });
});

describe("the index in the tool's description", () => {
  it("opens with who the agent is talking to", () => {
    expect(described()).toContain(PREAMBLE);
  });

  it("lists every section of the guide", () => {
    const names = sections().map(({ name }) => name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(described(), name).toContain(name);
  });

  it("gives every Space type at least one section, each one the guide has", () => {
    const headings = sections().map(({ name }) => name);
    for (const type of SpaceTypeSchema.options) {
      const own = SPACE_SECTIONS[type] ?? [];
      expect(own.length, `${type} has sections`).toBeGreaterThan(0);
      for (const name of own) {
        expect(headings, `${type}: "${name}"`).toContain(name);
        expect(described(), `${type}: "${name}"`).toContain(name);
      }
    }
  });
});
