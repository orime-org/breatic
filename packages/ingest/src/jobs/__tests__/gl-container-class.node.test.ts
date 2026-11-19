// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `MiniToolContainerGl` Durable Object class (inner#1306 test plan §97; frames-split design §5.4 派发 row: one
 * `MiniToolContainerGl` job per transition window chunk, standard-4 size, its own image; 容量 row: both classes'
 * `max_instances` are deployment configuration).
 *
 * It sits beside `MiniToolContainerStd4`: the same job container base and outbound handlers, reached through its own
 * binding (chosen here: `MINI_TOOL_GL`, after `MINI_TOOL_STD4`), exported from the Worker entry, and declared in the
 * tracked `wrangler.toml.template` in both environments with the `gl` variant of `./Dockerfile` at standard-4. `wrangler.toml` is
 * each developer's own untracked copy, so the template is what a deployment is written from.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as containers from "@ingest/jobs/mini-tool-container.js";

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));

/** One `[header]` or `[[header]]` block of the template and its `key = value` lines. */
interface Block { header: string; values: Record<string, string> }

/**
 * The template's blocks in order. Values keep their text with surrounding quotes removed; placeholders stay as written.
 * @param text - The template.
 * @returns The blocks.
 */
function blocks(text: string): Block[] {
  const found: Block[] = [];
  for (const line of text.split("\n")) {
    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*$/.exec(line);
    if (header !== null) { found.push({ header: header[1]!, values: {} }); continue; }
    const pair = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (pair !== null && found.length > 0) found.at(-1)!.values[pair[1]!] = pair[2]!.replace(/^"(.*)"$/, "$1");
  }
  return found;
}

const TEMPLATE = blocks(readFileSync(join(__dirname, "../../../wrangler.toml.template"), "utf8"));
const ENVIRONMENTS = [{ name: "development", prefix: "" }, { name: "production", prefix: "env.production." }] as const;

/**
 * What the template declares for one class in one environment.
 * @param prefix - The environment's table prefix.
 * @param className - The class.
 * @returns Its container, its bindings and its export.
 */
function declared(prefix: string, className: string): { container: Record<string, string> | undefined; bindings: string[]; exported: Record<string, string> | undefined } {
  return {
    container: TEMPLATE.find((block) => block.header === `[[${prefix}containers]]` && block.values.class_name === className)?.values,
    bindings: TEMPLATE.filter((block) => block.header === `[[${prefix}durable_objects.bindings]]` && block.values.class_name === className).map((block) => block.values.name!),
    exported: TEMPLATE.find((block) => block.header === `[${prefix}exports.${className}]`)?.values,
  };
}

describe("the MiniToolContainerGl class beside MiniToolContainerStd4 (frames-split §5.4 派发 row)", () => {
  it("GL01 is reached through its own binding, MINI_TOOL_GL", () => {
    expect(containers.CLASS_BINDINGS).toMatchObject({ MiniToolContainerStd4: "MINI_TOOL_STD4", MiniToolContainerGl: "MINI_TOOL_GL" });
  });

  it("GL02 is its own class on the same job container base, with the same outbound handlers as standard-4", () => {
    const gl = (containers as unknown as Record<string, unknown>).MiniToolContainerGl as (typeof containers.MiniToolContainerStd4) | undefined;
    expect(typeof gl).toBe("function");
    expect(gl).not.toBe(containers.MiniToolContainerStd4);
    expect(Object.getPrototypeOf(gl)).toBe(Object.getPrototypeOf(containers.MiniToolContainerStd4));
    const handlers = (kind: unknown): string[] => Object.keys((kind as { outboundHandlers?: Record<string, unknown> }).outboundHandlers ?? {}).sort();
    expect(handlers(containers.MiniToolContainerStd4)).not.toEqual([]);
    expect(handlers(gl)).toEqual(handlers(containers.MiniToolContainerStd4));
  });

  it("GL03 is exported from the Worker entry with the other mini-tool containers", () => {
    const entry = readFileSync(join(__dirname, "../../index.ts"), "utf8");
    const exported = /export\s*\{([^}]*)\}\s*from\s*"@ingest\/jobs\/mini-tool-container\.js"/.exec(entry)?.[1]?.split(",").map((name) => name.trim());
    expect(exported).toEqual(expect.arrayContaining(["MiniToolContainerStd4", "MiniToolContainerGl"]));
  });

  it.each(ENVIRONMENTS)("GL04 the template reads the standard-4 declarations of the $name environment (control)", ({ prefix }) => {
    expect(declared(prefix, "MiniToolContainerStd4")).toEqual({
      container: expect.objectContaining({ image: "./Dockerfile", instance_type: "standard-4" }),
      bindings: ["MINI_TOOL_STD4"],
      exported: { type: "durable-object", storage: "sqlite" },
    });
  });

  it.each(ENVIRONMENTS)("GL05 the template declares MiniToolContainerGl in the $name environment: the gl variant of ./Dockerfile at standard-4, bound as MINI_TOOL_GL, a SQLite export", ({ prefix }) => {
    const gl = declared(prefix, "MiniToolContainerGl");
    // One Dockerfile and one build context for both images, so the GL image's service is built from the same code as standard-4's.
    expect(gl.container?.image_vars).toMatch(/\bVARIANT = "gl"/);
    expect(gl.container?.image_vars).not.toMatch(/BASE_IMAGE/);
    expect(gl).toEqual({
      container: expect.objectContaining({ image: "./Dockerfile", instance_type: "standard-4" }),
      bindings: ["MINI_TOOL_GL"],
      exported: { type: "durable-object", storage: "sqlite" },
    });
    // Its instance cap is the deployment's to set (§5.4 容量 row), as standard-4's is.
    expect(gl.container?.max_instances).toBeDefined();
  });
});
