// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { spaceDocWriteGateway } from "../space-doc-write-gateway";

/**
 * `breatic/space-doc-write-gateway` with `writeFunctions` (breatic#1488 §8.1):
 * the bodies of canvas writes live in `@breatic/shared/canvas-model` so collab
 * can run them too, outside web's lint scope. The web config names those
 * bodies, and a call to one counts as a Space write: it must sit inside a
 * `writeSpaceDoc(…)` or `runCanvasUndoBatch(…)` callback like a `transact`.
 */
const PRELUDE = [
  "declare const doc: unknown;",
  "declare function writeSpaceDoc(name: string, options: { kind: string }, write: () => void): { ok: boolean };",
  "declare function runCanvasUndoBatch(p: string, s: string, kind: string, fn: () => void): { ok: boolean };",
  "declare function writeProposalPrompt(d: unknown, nodeId: string, text: string): void;",
  "declare function addNodeToDoc(d: unknown, node: unknown): void;",
].join("\n");

/**
 * Prefixes a snippet with the declarations above.
 * @param lines The snippet, starting on line 6.
 * @returns The full source handed to the rule.
 */
function source(...lines: string[]): string {
  return `${PRELUDE}\n${lines.join("\n")}`;
}

const FILE = "/repo/packages/web/src/spaces/canvas/use-node-creation.ts";
const OPTIONS = [{ exceptions: [], writeFunctions: ["writeProposalPrompt", "addNodeToDoc"] }];

const ruleTester = new RuleTester();
ruleTester.run("space-doc-write-gateway writeFunctions", spaceDocWriteGateway, {
  valid: [
    {
      name: "a named body called inside a runCanvasUndoBatch callback",
      filename: FILE,
      options: OPTIONS,
      code: source("runCanvasUndoBatch('p', 's', 'content', () => { writeProposalPrompt(doc, 'n1', 'x'); });"),
    },
    {
      name: "a named body called inside a writeSpaceDoc callback",
      filename: FILE,
      options: OPTIONS,
      code: source("writeSpaceDoc('d', { kind: 'add' }, () => { addNodeToDoc(doc, {}); });"),
    },
    {
      name: "a function not in the list is not a write",
      filename: FILE,
      options: [{ exceptions: [], writeFunctions: ["addNodeToDoc"] }],
      code: source("writeProposalPrompt(doc, 'n1', 'x');"),
    },
  ],
  invalid: [
    {
      name: "a named body called at top level",
      filename: FILE,
      options: OPTIONS,
      code: source("writeProposalPrompt(doc, 'n1', 'x');"),
      errors: [{ messageId: "outsideWriteGateway", line: 6, column: 1 }],
    },
    {
      name: "a named body called in a plain function",
      filename: FILE,
      options: OPTIONS,
      code: source("function place(): void {", "  addNodeToDoc(doc, {});", "}"),
      errors: [{ messageId: "outsideWriteGateway", line: 7, column: 3 }],
    },
  ],
});

describe("space-doc-write-gateway writeFunctions option schema", () => {
  /**
   * Lints a trivial file with the rule configured with some options.
   * @param options The rule options under test.
   * @returns The lint messages, when the options are accepted.
   * @throws {Error} When the options fail the rule's schema.
   */
  function lintWith(options: Record<string, unknown>): Linter.LintMessage[] {
    const linter = new Linter();
    return linter.verify("export const a = 1;\n", [
      {
        plugins: { breatic: { rules: { "space-doc-write-gateway": spaceDocWriteGateway } } },
        rules: { "breatic/space-doc-write-gateway": ["error", options] },
      },
    ]);
  }

  it("accepts a list of names", () => {
    expect(lintWith({ exceptions: [], writeFunctions: ["writeProposalPrompt"] })).toEqual([]);
  });

  it.each([
    ["an empty name", { exceptions: [], writeFunctions: [""] }],
    ["a non-string entry", { exceptions: [], writeFunctions: [1] }],
  ])("rejects %s", (_label, options) => {
    expect(() => lintWith(options)).toThrow(/breatic\/space-doc-write-gateway/);
  });
});
