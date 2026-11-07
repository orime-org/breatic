// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { Linter } from "eslint";
import globals from "globals";
import { describe, expect, it } from "vitest";
import { spaceDocWriteGateway } from "../space-doc-write-gateway";

/**
 * `breatic/space-doc-write-gateway` (inner#1790): every write to a Space
 * document has to sit, literally, inside a callback handed to
 * `writeSpaceDoc(…)` or `runCanvasUndoBatch(…)`, which is where the size cap is
 * checked. The match is syntactic — web lints without type information.
 *
 * Case ids (L-xx, V-xx) are the ones in section 1 of the inner#1790 v2 lint
 * and smoke test spec, so a red case here can be looked up there. Every
 * snippet is prefixed with the six declarations in `PRELUDE` (the spec's
 * "D"), so the snippet body starts on line 7 and every expected line number
 * is absolute.
 */
const PRELUDE = [
  "declare const doc: { transact(fn: () => void, origin?: unknown): void };",
  "declare function getDoc(name: string): { transact(fn: () => void): void };",
  "declare function writeSpaceDoc(name: string, options: { kind: string; notify?: boolean }, write: () => void): { ok: boolean };",
  "declare function runCanvasUndoBatch(p: string, s: string, kind: string, fn: () => void): { ok: boolean };",
  "declare function writePlainTextIntoBody(body: unknown, text: string): void;",
  "declare function applyTimelineEdit(d: unknown, c: unknown, o: unknown): unknown;",
].join("\n");

/**
 * Prefixes a snippet with the shared declarations.
 * @param lines The snippet, one entry per line, starting at line 7.
 * @returns The full source handed to the rule.
 */
function source(...lines: string[]): string {
  return `${PRELUDE}\n${lines.join("\n")}`;
}

/** Where a file lives, as RuleTester is told; only the suffix matters. */
const WEB = "/repo/packages/web/";

/**
 * The exception table every case runs with ("option E"): the five entries
 * the web config may keep once the temporary merge exceptions are gone
 * (spec C-02). Which of the five stay is decided by the dead-exception check
 * (C-04, in `space-doc-write-gateway-config.test.ts`); the rule's behaviour
 * per entry is what is pinned here.
 */
const OPTION_E = {
  exceptions: [
    {
      file: "src/data/yjs/canvas-space.ts",
      function: "writeSnapshotNodes",
      reason: "Takes a Y.Doc and writes both scratch documents and real Spaces; the real caller checks in its runCanvasUndoBatch.",
    },
    {
      file: "src/data/yjs/canvas-space.ts",
      function: "landHandlingContent",
      reason: "Only called inside the already-checked writes of setNodeExtractedText and restoreNodeMedia.",
    },
    {
      file: "src/spaces/canvas/generate/proposal-prompt.ts",
      function: "writeProposalPrompt",
      reason: "Only called inside the placeProposalAt batch.",
    },
    {
      file: "src/data/yjs/scene-document.ts",
      function: "applySceneCommand",
      reason: "planSceneCommand checks the size state and returns full, over_ceiling or resyncing first.",
    },
    {
      file: "src/data/yjs/scene-session.ts",
      function: "historyStep",
      reason: "historyStep checks the step through nextHistoryStep and returns full, over_ceiling or resyncing first.",
    },
  ],
};

/** The exception entries that are class methods rather than functions. */
const METHOD_EXCEPTIONS = new Set(["historyStep"]);

const NO_EXCEPTIONS = { exceptions: [] };

/** One expected report. */
type Report = { messageId: "outsideWriteGateway"; line: number; column: number };

/**
 * One expected report: the only message id the rule has, at the start of the
 * matched call expression.
 * @param line Absolute line of the call expression.
 * @param column Column of its first character.
 * @returns The RuleTester error entry.
 */
function at(line: number, column: number): Report {
  return { messageId: "outsideWriteGateway", line, column };
}

/**
 * The report at the first occurrence of a piece of code in a source.
 * @param code The full source.
 * @param needle The start of the reported call, as written.
 * @returns The RuleTester error entry.
 * @throws {Error} When the needle is not in the source.
 */
function reportAt(code: string, needle: string): Report {
  const lines = code.split("\n");
  for (const [index, line] of lines.entries()) {
    const column = line.indexOf(needle);
    if (column >= 0) return at(index + 1, column + 1);
  }
  throw new Error(`"${needle}" is not in the source`);
}

/**
 * V-09 / V-11: a function (or a class method) named after one exception, in
 * that exception's file, holding an L-01 write and, one function deeper, an
 * L-08 write.
 */
const EXCEPTION_CASES = OPTION_E.exceptions.map((exception) => {
  const code = METHOD_EXCEPTIONS.has(exception.function)
    ? source(
      "declare const undoManager: { undo(): void; redo(): void };",
      "export class Excepted {",
      `  ${exception.function}(): void {`,
      "    doc.transact(() => {});",
      "    [1].forEach(() => { undoManager.undo(); });",
      "  }",
      "}",
    )
    : source(
      "declare const undoManager: { undo(): void; redo(): void };",
      `export function ${exception.function}(): void {`,
      "  doc.transact(() => {});",
      "  [1].forEach(() => { undoManager.undo(); });",
      "}",
    );
  return {
    id: `${exception.function} in ${exception.file}`,
    filename: `${WEB}${exception.file}`,
    code,
    reports: [reportAt(code, "doc.transact("), reportAt(code, "undoManager.undo(")],
  };
});

/**
 * V-02: each write call of L-01 to L-11, with the declarations it needs, on
 * its own inside a `writeSpaceDoc` callback.
 */
const INSIDE_GATEWAY: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ["L-01", [], "doc.transact(() => {})"],
  ["L-02", ["declare const docs: { transact(fn: () => void): void };"], "docs.transact(() => {})"],
  ["L-03", ["declare const self: { doc: typeof doc };"], "self.doc.transact(() => {})"],
  ["L-04", [], "getDoc('canvas:p:s').transact(() => {})"],
  ["L-05a", ["declare const shots: { doc: typeof doc | null };"], "shots.doc?.transact(() => {})"],
  ["L-05b", [], "doc?.transact(() => {})"],
  ["L-06", ["declare function transact(d: unknown, fn: () => void): void;"], "transact(doc, () => {})"],
  ["L-07", [], "doc['transact'](() => {})"],
  ["L-08a", ["declare const undoManager: { undo(): void; redo(): void };"], "undoManager.undo()"],
  ["L-08b", ["declare const undoManager: { undo(): void; redo(): void };"], "undoManager.redo()"],
  ["L-08c", ["declare const session: { undo(): void };"], "session.undo()"],
  ["L-08d", ["declare const undoManagerRef: { current: { undo(): void } | null };"], "undoManagerRef.current?.undo()"],
  ["L-09a", ["declare const x: Record<string, () => void>;"], "x['undo']()"],
  ["L-09b", ["declare const x: Record<string, () => void>;"], "x['redo']()"],
  [
    "L-09c",
    ["declare const x: Record<string, () => void>;", "declare const direction: string;"],
    "x[direction]()",
  ],
  [
    "L-10a",
    ["declare const k: string;", "declare const sceneHistory: Record<string, () => void>;"],
    "sceneHistory[k]()",
  ],
  [
    "L-10b",
    ["declare const k: string;", "declare const HISTORY: Record<string, () => void>;"],
    "HISTORY[k]()",
  ],
  [
    "L-10c",
    ["declare const k: string;", "declare const canvasUndoManager: Record<string, () => void>;"],
    "canvasUndoManager[k]()",
  ],
  [
    "L-10d",
    ["declare const k: string;", "declare const undoManagerRef: { current: Record<string, () => void> };"],
    "undoManagerRef.current[k]()",
  ],
  [
    "L-10e",
    ["declare const k: string;", "declare const store: { history: { entries: Record<string, () => void> } };"],
    "store.history.entries[k]()",
  ],
  ["L-11a", ["declare const body: unknown;"], "writePlainTextIntoBody(body, 'w')"],
  ["L-11b", [], "applyTimelineEdit(doc, {}, null)"],
];

const CASES = {
  valid: [
    {
      name: "V-01 inside an arrow callback and a function-expression callback of writeSpaceDoc",
      code: source(
        "writeSpaceDoc('n', { kind: 'add' }, () => { doc.transact(() => {}); });",
        "writeSpaceDoc('n', { kind: 'remove', notify: false }, function write(): void { getDoc('n').transact(() => {}); });",
      ),
    },
    ...INSIDE_GATEWAY.map(([id, declarations, call]) => ({
      name: `V-02 (${id}) ${call} inside writeSpaceDoc`,
      code: source(...declarations, `writeSpaceDoc('n', { kind: 'add' }, () => { ${call}; });`),
    })),
    {
      name: "V-03 the runCanvasUndoBatch callback is a gateway",
      code: source(
        "runCanvasUndoBatch('p', 's', 'add', () => { writePlainTextIntoBody(null, 'w'); doc.transact(() => {}); });",
      ),
    },
    {
      name: "V-04 nested functions, deferred writes and nested gateways stay inside the callback",
      code: source(
        "declare const ids: string[];",
        "writeSpaceDoc('n', { kind: 'remove' }, () => { ids.forEach((id) => doc.transact(() => void id)); });",
        "writeSpaceDoc('n', { kind: 'add' }, () => { setTimeout(() => doc.transact(() => {}), 0); });",
        "writeSpaceDoc('a', { kind: 'add' }, () => { writeSpaceDoc('b', { kind: 'delete' }, () => { doc.transact(() => {}); }); });",
      ),
    },
    {
      name: "V-05 a receiver whose last segment is editor is the BlockNote editor",
      code: source(
        "declare const editor: { transact<T>(run: (tr: unknown) => T): T; undo(): void; redo(): void };",
        "declare const props: { editor: typeof editor };",
        "editor.transact((tr) => tr);",
        "editor.undo();",
        "props.editor.redo();",
        "export class Host { editor = editor; run(): void { this.editor.undo(); this.editor.transact((tr) => tr); } }",
      ),
    },
    {
      name: "V-06 a bare undo() and methods not named undo or redo",
      code: source(
        "declare function undo(): void;",
        "declare const session: { undoMark(): void; historyStep(d: string): void };",
        "declare const u: { stopCapturing(): void } | null;",
        "undo();",
        "session.undoMark();",
        "session.historyStep('undo');",
        "u?.stopCapturing();",
      ),
    },
    {
      name: "V-07 computed calls whose key and receiver both miss the criteria",
      code: source(
        "declare const toast: Record<string, (m: string) => void>;",
        "declare const severity: string;",
        "declare const startPick: Record<string, (id: string) => void>;",
        "declare const slot: string;",
        "declare const segments: Iterable<unknown>;",
        "declare const handlers: Record<string, () => void>;",
        "toast[severity]('x');",
        "startPick[slot]('id');",
        "segments[Symbol.iterator]();",
        "handlers['other']();",
      ),
    },
    {
      name: "V-08 a type signature, a comment and a string are not calls",
      code: source(
        "export interface Editorish { transact: <T>(run: () => T) => T }",
        "// doc.transact(() => {}) in a comment",
        "export const text = 'doc.transact(';",
      ),
    },
    ...EXCEPTION_CASES.map((exception) => ({
      name: `V-09 ${exception.id}: the exception covers every function inside it`,
      filename: exception.filename,
      code: exception.code,
    })),
    {
      name: "V-10 calling a function that writes inside is not itself a write",
      code: source(
        "declare function writeSnapshotNodes(d: unknown): void;",
        "declare function removeTimelineClip(d: unknown, id: string, o: unknown): void;",
        "writeSnapshotNodes(doc);",
        "removeTimelineClip(doc, 'c', null);",
      ),
    },
  ].map((testCase) => ({ ...testCase, options: [OPTION_E] })),
  invalid: [
    {
      name: "L-01 doc.transact",
      code: source("doc.transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-02 a receiver under any other name than editor",
      code: source("declare const docs: { transact(fn: () => void): void };", "docs.transact(() => {});"),
      errors: [at(8, 1)],
    },
    {
      name: "L-03 this.doc.transact in a class method",
      code: source("export class S { doc = doc; write(): void { this.doc.transact(() => {}); } }"),
      errors: [at(7, 45)],
    },
    {
      name: "L-04 a call result as the receiver",
      code: source("getDoc('canvas:p:s').transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-05 optional chains",
      code: source(
        "declare const shots: { doc: typeof doc | null };",
        "shots.doc?.transact(() => {});",
        "doc?.transact(() => {});",
      ),
      errors: [at(8, 1), at(9, 1)],
    },
    {
      name: "L-06 yjs's standalone transact",
      code: source("declare function transact(d: unknown, fn: () => void): void;", "transact(doc, () => {});"),
      errors: [at(8, 1)],
    },
    {
      name: "L-07 doc['transact']",
      code: source("doc['transact'](() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-08 undo() and redo() on receivers that are not editor",
      code: source(
        "declare const undoManager: { undo(): void; redo(): void };",
        "declare const session: { undo(): void };",
        "declare const undoManagerRef: { current: { undo(): void } | null };",
        "undoManager.undo();",
        "undoManager.redo();",
        "session.undo();",
        "undoManagerRef.current?.undo();",
      ),
      errors: [at(10, 1), at(11, 1), at(12, 1), at(13, 1)],
    },
    {
      name: "L-09 computed keys 'undo', 'redo' and direction",
      code: source(
        "declare const x: Record<string, () => void>;",
        "declare const direction: string;",
        "declare const k: string;",
        "x['undo']();",
        "x['redo']();",
        "x[direction]();",
      ),
      errors: [at(10, 1), at(11, 1), at(12, 1)],
    },
    {
      name: "L-10 a receiver chain with history or undoManager in any segment, any case",
      code: source(
        "declare const x: Record<string, () => void>;",
        "declare const direction: string;",
        "declare const k: string;",
        "declare const sceneHistory: Record<string, () => void>;",
        "declare const HISTORY: typeof sceneHistory;",
        "declare const canvasUndoManager: typeof sceneHistory;",
        "declare const undoManagerRef: { current: typeof sceneHistory };",
        "declare const store: { history: { entries: typeof sceneHistory } };",
        "sceneHistory[k]();",
        "HISTORY[k]();",
        "canvasUndoManager[k]();",
        "undoManagerRef.current[k]();",
        "store.history.entries[k]();",
      ),
      errors: [at(15, 1), at(16, 1), at(17, 1), at(18, 1), at(19, 1)],
    },
    {
      name: "L-11 writePlainTextIntoBody and applyTimelineEdit",
      code: source(
        "declare const body: unknown;",
        "writePlainTextIntoBody(body, 'w');",
        "applyTimelineEdit(doc, {}, null);",
      ),
      errors: [at(8, 1), at(9, 1)],
    },
    {
      name: "L-12 a function passed to writeSpaceDoc by variable is not inside it",
      code: source(
        "const write = (): void => doc.transact(() => {});",
        "writeSpaceDoc('n', { kind: 'add' }, write);",
      ),
      errors: [at(7, 27)],
    },
    {
      name: "L-13 a write after the gateway call, outside its callback",
      code: source("writeSpaceDoc('n', { kind: 'delete' }, () => {});", "doc.transact(() => {});"),
      errors: [at(8, 1)],
    },
    {
      name: "L-14 each write is reported, not only the first",
      code: source("doc.transact(() => {});", "getDoc('n').transact(() => {});"),
      errors: [at(7, 1), at(8, 1)],
    },
    {
      name: "L-15 an aliased import and a member call are not gateways (known limit)",
      code: source(
        "import { writeSpaceDoc as gate } from '@web/data/yjs/space-write';",
        "gate('n', { kind: 'add' }, () => { doc.transact(() => {}); });",
        "declare const sw: { writeSpaceDoc: typeof writeSpaceDoc };",
        "sw.writeSpaceDoc('n', { kind: 'add' }, () => { doc.transact(() => {}); });",
      ),
      errors: [at(8, 36), at(10, 48)],
    },
    {
      name: "L-16 a function that is not excepted, in an excepted file",
      filename: `${WEB}src/data/yjs/canvas-space.ts`,
      code: source("export function addNode(): void {", "  doc.transact(() => {});", "}"),
      errors: [at(8, 3)],
    },
    {
      name: "L-17 an excepted function name in another file",
      filename: `${WEB}src/pages/project/chat/paste-canvas.ts`,
      code: source("export function writeSnapshotNodes(): void {", "  doc.transact(() => {});", "}"),
      errors: [at(8, 3)],
    },
    {
      name: "L-18 the file suffix matches only at a / boundary",
      filename: `${WEB}src/data/yjs/my-canvas-space.ts`,
      code: source("export function writeSnapshotNodes(): void {", "  doc.transact(() => {});", "}"),
      errors: [at(8, 3)],
    },
    {
      name: "L-19 another method of SceneSession in scene-session.ts",
      filename: `${WEB}src/data/yjs/scene-session.ts`,
      code: source(
        "export class SceneSession {",
        "  history = { undo(): void {}, redo(): void {} };",
        "  replay(direction: 'undo' | 'redo'): void { this.history[direction](); }",
        "}",
      ),
      errors: [at(9, 46)],
    },
  ].map((testCase) => ({ ...testCase, options: [OPTION_E] })),
};

// V-11: the V-09 cases with an empty table, each reported twice: the pass in
// V-09 comes from the table, not from a matcher that never saw the writes.
const WITHOUT_EXCEPTIONS = {
  valid: [],
  invalid: EXCEPTION_CASES.map((exception) => ({
    name: `V-11 ${exception.id} with an empty exception table`,
    filename: exception.filename,
    code: exception.code,
    options: [NO_EXCEPTIONS],
    errors: exception.reports,
  })),
};

/**
 * Every case runs with no globals declared and under the browser globals web
 * lints with (`history` is one of them), per the RuleTester guidance in
 * .claude/skills/build-tooling/guards.md.
 */
const ENVIRONMENTS: ReadonlyArray<{
  name: string;
  globals: Record<string, boolean | "readonly" | "writable" | "off">;
}> = [
  { name: "no environment declared", globals: {} },
  { name: "globals.browser, the web package", globals: globals.browser },
];

for (const environment of ENVIRONMENTS) {
  const ruleTester = new RuleTester({ languageOptions: { globals: environment.globals } });
  ruleTester.run(`space-doc-write-gateway (${environment.name})`, spaceDocWriteGateway, CASES);
  ruleTester.run(
    `space-doc-write-gateway without exceptions (${environment.name})`,
    spaceDocWriteGateway,
    WITHOUT_EXCEPTIONS,
  );
}

describe("L-30 space-doc-write-gateway options schema", () => {
  /**
   * Lints a trivial file with the rule configured with some options.
   * Flat-config `Linter` validates rule options against `meta.schema` and
   * throws on a mismatch.
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

  const COMPLETE = { file: "src/data/yjs/canvas-space.ts", function: "writeSnapshotNodes", reason: "A reason." };

  it("L-30 accepts a complete exception entry", () => {
    // The control: without it, every rejection below could be the rule
    // failing to load rather than the schema refusing the entry.
    expect(lintWith({ exceptions: [COMPLETE] })).toEqual([]);
  });

  it.each([
    ["an entry without reason", { exceptions: [{ file: COMPLETE.file, function: COMPLETE.function }] }],
    ["an entry with an empty reason", { exceptions: [{ ...COMPLETE, reason: "" }] }],
    ["an entry whose reason is only whitespace", { exceptions: [{ ...COMPLETE, reason: "   " }] }],
    ["an entry without file", { exceptions: [{ function: COMPLETE.function, reason: COMPLETE.reason }] }],
    ["an entry with an empty file", { exceptions: [{ ...COMPLETE, file: "" }] }],
    ["an entry without function", { exceptions: [{ file: COMPLETE.file, reason: COMPLETE.reason }] }],
    ["an entry with an empty function", { exceptions: [{ ...COMPLETE, function: "" }] }],
    ["an entry with an extra key", { exceptions: [{ ...COMPLETE, note: "x" }] }],
    ["an extra top-level key", { exceptions: [COMPLETE], allow: [] }],
  ])("L-30 rejects %s", (_label, options) => {
    expect(() => lintWith(options)).toThrow(/breatic\/space-doc-write-gateway/);
  });
});
