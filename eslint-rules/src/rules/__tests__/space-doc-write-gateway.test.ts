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
 * Case ids (L-xx) are the ones in the inner#1790 lint test spec, so a red case
 * here can be looked up there. Every snippet is prefixed with the six
 * declarations in `PRELUDE`, so the snippet body starts on line 7 and every
 * expected line number is absolute.
 */
const PRELUDE = [
  "declare const doc: { transact(fn: () => void, origin?: unknown): void };",
  "declare const ydoc: { transact(fn: () => void): void };",
  "declare function getDoc(name: string): { transact(fn: () => void): void };",
  "declare function writeSpaceDoc(name: string, options: { kind: string; estimate?: number }, write: () => void): { ok: boolean };",
  "declare function writePlainTextIntoBody(body: unknown, text: string): void;",
  "declare function applyTimelineEdit(target: unknown, command: unknown): boolean;",
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
 * The exception table the web config passes (spec 1.5 B, "option E"): five
 * entries, each a file suffix, the enclosing named function or method, and a
 * reason. Every case below runs with it, not only the exception cases.
 */
const OPTION_E = {
  exceptions: [
    {
      file: "src/data/yjs/canvas-space.ts",
      function: "writeSnapshotNodes",
      reason:
        "Takes a Y.Doc and writes both scratch documents and real Spaces; the real caller checks in its runCanvasUndoBatch.",
    },
    {
      file: "src/data/yjs/canvas-space.ts",
      function: "landHandlingContent",
      reason:
        "Only called inside the already-checked writes of setNodeExtractedText and restoreNodeMedia.",
    },
    {
      file: "src/spaces/canvas/generate/proposal-prompt.ts",
      function: "writeProposalPrompt",
      reason: "Only called inside the placeProposalAt batch.",
    },
    {
      file: "src/data/yjs/scene-document.ts",
      function: "applySceneCommand",
      reason: "3D checks the size state in planSceneCommand and returns full.",
    },
    {
      file: "src/data/yjs/scene-session.ts",
      function: "historyStep",
      reason: "historyStep reads the size state and returns early.",
    },
  ],
};

const NO_EXCEPTIONS = { exceptions: [] };

/**
 * One expected report: the only message id the rule has, at the start of the
 * matched call expression.
 * @param line Absolute line of the call expression.
 * @param column Column of its first character.
 * @returns The RuleTester error entry.
 */
function at(
  line: number,
  column: number,
): { messageId: "outsideWriteGateway"; line: number; column: number } {
  return { messageId: "outsideWriteGateway", line, column };
}

// The exception cases (L-41a–e). Kept apart so the same code can be run once
// with option E (no report) and once with an empty table (one report each):
// the second run proves the pass comes from the table, not from a matcher
// that never saw the write.
const EXCEPTION_CASES = [
  {
    id: "L-41a writeSnapshotNodes in canvas-space.ts",
    filename: `${WEB}src/data/yjs/canvas-space.ts`,
    code: source(
      "export function writeSnapshotNodes(): void {",
      "  doc.transact(() => {});",
      "}",
    ),
    report: at(8, 3),
  },
  {
    id: "L-41b writeProposalPrompt in proposal-prompt.ts",
    filename: `${WEB}src/spaces/canvas/generate/proposal-prompt.ts`,
    code: source(
      "declare const prompt: { doc: typeof doc | null };",
      "export function writeProposalPrompt(): void {",
      "  const replace = (): void => {};",
      "  if (prompt.doc) prompt.doc.transact(replace);",
      "}",
    ),
    report: at(10, 19),
  },
  {
    id: "L-41c applySceneCommand in scene-document.ts",
    filename: `${WEB}src/data/yjs/scene-document.ts`,
    code: source(
      "export function applySceneCommand(): void {",
      "  doc.transact(() => {}, Symbol('origin'));",
      "}",
    ),
    report: at(8, 3),
  },
  {
    id: "L-41d SceneSession.historyStep in scene-session.ts",
    filename: `${WEB}src/data/yjs/scene-session.ts`,
    code: source(
      "export class SceneSession {",
      "  history = { undo(): void {}, redo(): void {} };",
      "  historyStep(direction: 'undo' | 'redo'): void {",
      "    this.history[direction]();",
      "  }",
      "}",
    ),
    report: at(10, 5),
  },
  {
    id: "L-41e landHandlingContent in canvas-space.ts",
    filename: `${WEB}src/data/yjs/canvas-space.ts`,
    code: source(
      "declare const body: unknown;",
      "function landHandlingContent(): void {",
      "  writePlainTextIntoBody(body, 'w');",
      "}",
    ),
    report: at(9, 3),
  },
];

/**
 * L-32a–k: every shape that is reported outside a gateway passes inside one.
 * Each entry is the declaration it needs (line 7) and the call.
 */
const INSIDE_GATEWAY: ReadonlyArray<readonly [string, string, string]> = [
  ["a", "declare const x: { doc: typeof doc };", "x.doc.transact(() => {})"],
  ["b", "", "getDoc('n').transact(() => {})"],
  ["c", "declare const shots: { doc: typeof doc | null };", "shots.doc?.transact(() => {})"],
  ["d", "", "doc?.transact(() => {})"],
  ["e", "declare const undoManager: { undo(): void; redo(): void };", "undoManager.undo()"],
  ["f", "declare const undoManager: { undo(): void; redo(): void };", "undoManager.redo()"],
  [
    "g",
    "declare const undoManagerRef: { current: { undo(): void; redo(): void } | null };",
    "undoManagerRef.current?.undo()",
  ],
  ["h", "declare const rollback: { undo(): void; destroy(): void };", "rollback.undo()"],
  [
    "i",
    "declare const history: { undo(): void; redo(): void }; declare const direction: 'undo' | 'redo';",
    "history[direction]()",
  ],
  ["j", "declare const body: unknown;", "writePlainTextIntoBody(body, 'w')"],
  ["k", "", "applyTimelineEdit(doc, {})"],
];

const CASES = {
  valid: [
    // L-30: arrow-function callback.
    {
      name: "L-30 inside an arrow callback of writeSpaceDoc",
      code: source(
        "writeSpaceDoc('n', { kind: 'add', estimate: 10 }, () => { doc.transact(() => {}); });",
      ),
    },
    // L-31: function-expression callback.
    {
      name: "L-31 inside a function-expression callback of writeSpaceDoc",
      code: source(
        "writeSpaceDoc('n', { kind: 'add' }, function write(): void { ydoc.transact(() => {}); });",
      ),
    },
    ...INSIDE_GATEWAY.map(([letter, declaration, call]) => ({
      name: `L-32${letter} ${call} inside writeSpaceDoc`,
      code: source(
        ...(declaration === "" ? [] : [declaration]),
        `writeSpaceDoc('n', { kind: 'add' }, () => { ${call}; });`,
      ),
    })),
    {
      name: "L-33 a function nested in the callback is still inside it",
      code: source(
        "declare const nodes: string[];",
        "writeSpaceDoc('n', { kind: 'add' }, () => { nodes.forEach((id) => doc.transact(() => void id)); });",
      ),
    },
    {
      name: "L-34 nested gateways",
      code: source(
        "writeSpaceDoc('a', { kind: 'add' }, () => { writeSpaceDoc('b', { kind: 'delete' }, () => { doc.transact(() => {}); }); });",
      ),
    },
    {
      name: "L-35 BlockNote editor.transact / undo / redo",
      code: source(
        "declare const editor: { transact<T>(run: (tr: unknown) => T): T; undo(): void; redo(): void };",
        "editor.transact((tr) => tr);",
        "editor.undo();",
        "editor.redo();",
      ),
    },
    {
      name: "L-36 bare undo() / redo() calls are not member calls",
      code: source(
        "declare function undo(): void;",
        "declare function redo(): void;",
        "undo();",
        "redo();",
      ),
    },
    {
      name: "L-37 methods that are not named undo / redo",
      code: source(
        "declare const session: { undoMark(): void; undoDrawing(): void; historyStep(d: string): void };",
        "declare const undo: { stopCapturing(): void } | null;",
        "session.undoMark();",
        "session.undoDrawing();",
        "undo?.stopCapturing();",
        "session.historyStep('undo');",
      ),
    },
    {
      name: "L-38 computed calls unrelated to Space writes",
      code: source(
        "declare const toast: Record<string, (m: string) => void>;",
        "declare const severity: string;",
        "declare const startPick: Record<string, (id: string) => void>;",
        "declare const slot: string;",
        "declare const segments: Iterable<unknown>;",
        "toast[severity]('x');",
        "startPick[slot]('id');",
        "segments[Symbol.iterator]();",
      ),
    },
    {
      name: "L-40b the BlockNote editor behind a type assertion",
      code: source(
        "type Editorish = { transact<T>(run: () => T): T };",
        "declare const editor: unknown;",
        "(editor as Editorish).transact(() => 1);",
      ),
    },
    {
      name: "L-40 type signature, comment and string are not calls",
      code: source(
        "export interface Editorish { transact: <T>(run: () => T) => T }",
        "// doc.transact(() => {}) in a comment",
        "export const text = 'doc.transact(';",
      ),
    },
    ...EXCEPTION_CASES.map((exception) => ({
      name: `${exception.id} (exception table)`,
      filename: exception.filename,
      code: exception.code,
    })),
    {
      name: "L-42 calling an excepted function is not a write",
      code: source(
        "declare function writeSnapshotNodes(d: unknown, n: unknown[], e: unknown[]): void;",
        "declare function writeProposalPrompt(p: unknown, s: unknown[]): void;",
        "declare function applySceneCommand(d: unknown, c: unknown, o: symbol, e: boolean): unknown;",
        "writeSnapshotNodes(doc, [], []);",
        "writeProposalPrompt(null, []);",
        "applySceneCommand(doc, {}, Symbol('o'), true);",
      ),
    },
    {
      name: "L-72 the runCanvasUndoBatch callback is a gateway",
      code: source(
        "declare const body: unknown;",
        "declare function runCanvasUndoBatch(p: string, s: string, o: { kind: string; estimate?: number }, fn: () => void): { ok: boolean };",
        "runCanvasUndoBatch('p', 's', { kind: 'add', estimate: 1 }, () => { writePlainTextIntoBody(body, 'w'); doc.transact(() => {}); });",
      ),
    },
    {
      name: "L-73 the callback's argument position does not matter",
      code: source(
        "declare const body: unknown;",
        "declare function runCanvasUndoBatch(p: string, s: string, fn: () => void): void;",
        "runCanvasUndoBatch('p', 's', () => writePlainTextIntoBody(body, 'w'));",
      ),
    },
    {
      name: "L-74 computed call whose key and receiver both miss the criteria",
      code: source(
        "declare const handlers: Record<string, () => void>;",
        "declare const action: string;",
        "handlers[action]();",
        "handlers['other']();",
      ),
    },
    {
      name: "L-75 a deferred write inside the callback is literally inside it (known limit)",
      code: source(
        "writeSpaceDoc('n', { kind: 'add' }, () => { setTimeout(() => doc.transact(() => {}), 0); });",
      ),
    },
    {
      name: "L-76 a receiver whose last member is editor is an editor",
      code: source(
        "declare const props: { editor: { transact<T>(run: (tr: unknown) => T): T; undo(): void; redo(): void } };",
        "export class Host {",
        "  editor = props.editor;",
        "  run(): void {",
        "    this.editor.undo();",
        "    props.editor.redo();",
        "    props.editor.transact((tr) => tr);",
        "  }",
        "}",
      ),
    },
  ].map((testCase) => ({ ...testCase, options: [OPTION_E] })),
  invalid: [
    {
      name: "L-39c yjs's standalone transact through a named import",
      code: source(
        "import { transact } from 'yjs';",
        "declare const doc: import('yjs').Doc;",
        "transact(doc, () => {});",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-39b a history chain behind a type assertion",
      code: source(
        "declare const undoManagerRef: { current: unknown };",
        "declare const k: 'undo' | 'redo';",
        "type UM = { undo(): void; redo(): void };",
        "(undoManagerRef.current as UM)[k]();",
      ),
      errors: [at(10, 1)],
    },
    {
      name: "L-39 a receiver under any other name",
      code: source(
        "declare const docs: { transact(fn: () => void): void };",
        "declare const ctx: { space: { transact(fn: () => void): void } };",
        "docs.transact(() => {});",
        "ctx.space.transact(() => {});",
      ),
      errors: [at(9, 1), at(10, 1)],
    },
    {
      name: "L-01 doc.transact",
      code: source("doc.transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-02 ydoc.transact",
      code: source("ydoc.transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-03 a receiver ending in .doc",
      code: source(
        "declare const x: { doc: typeof doc };",
        "x.doc.transact(() => {});",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-04 this.doc.transact",
      code: source(
        "export class S {",
        "  doc = doc;",
        "  write(): void {",
        "    this.doc.transact(() => {});",
        "  }",
        "}",
      ),
      errors: [at(10, 5)],
    },
    {
      name: "L-05 prompt.doc.transact outside writeProposalPrompt in the same file",
      filename: `${WEB}src/spaces/canvas/generate/proposal-prompt.ts`,
      code: source(
        "declare const prompt: { doc: typeof doc | null };",
        "export function otherWriter(replace: () => void): void {",
        "  if (prompt.doc) prompt.doc.transact(replace);",
        "}",
      ),
      errors: [at(9, 19)],
    },
    {
      name: "L-06 shots.doc?.transact",
      code: source(
        "declare const shots: { doc: typeof doc | null };",
        "shots.doc?.transact(() => {});",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-07 getDoc(…).transact",
      code: source("getDoc('canvas:p:s').transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-08 getDoc(…)?.transact",
      code: source("getDoc('canvas:p:s')?.transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-09 doc?.transact",
      code: source("doc?.transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-10 a call written across two lines",
      code: source("doc", "  .transact(() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-11 undo() on a receiver that is not editor",
      code: source(
        "declare const undoManager: { undo(): void; redo(): void };",
        "undoManager.undo();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-12 redo() on a receiver that is not editor",
      code: source(
        "declare const undoManager: { undo(): void; redo(): void };",
        "undoManager.redo();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-13 undo through a ref",
      code: source(
        "declare const undoManagerRef: { current: { undo(): void; redo(): void } | null };",
        "undoManagerRef.current?.undo();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-14 redo through a ref",
      code: source(
        "declare const undoManagerRef: { current: { undo(): void; redo(): void } | null };",
        "undoManagerRef.current?.redo();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-15 a rollback undo",
      code: source(
        "declare const rollback: { undo(): void; destroy(): void };",
        "rollback.undo();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-16 history[direction]()",
      code: source(
        "declare const history: { undo(): void; redo(): void };",
        "declare const direction: 'undo' | 'redo';",
        "history[direction]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-17 another method of SceneSession in scene-session.ts",
      filename: `${WEB}src/data/yjs/scene-session.ts`,
      code: source(
        "export class SceneSession {",
        "  history = { undo(): void {}, redo(): void {} };",
        "  replay(direction: 'undo' | 'redo'): void {",
        "    this.history[direction]();",
        "  }",
        "}",
      ),
      errors: [at(10, 5)],
    },
    {
      name: "L-18 writePlainTextIntoBody",
      code: source(
        "declare const body: unknown;",
        "writePlainTextIntoBody(body, 'words');",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-19 applyTimelineEdit",
      code: source("applyTimelineEdit(doc, { operation: 'set_start' });"),
      errors: [at(7, 1)],
    },
    {
      name: "L-20 each write is reported, not only the first",
      code: source("doc.transact(() => {});", "ydoc.transact(() => {});"),
      errors: [at(7, 1), at(8, 1)],
    },
    {
      name: "L-21 a function passed to writeSpaceDoc by variable is not inside it",
      code: source(
        "const write = (): void => doc.transact(() => {});",
        "writeSpaceDoc('n', { kind: 'add' }, write);",
      ),
      errors: [at(7, 27)],
    },
    {
      name: "L-22 a function passed to runCanvasUndoBatch by variable is not inside it",
      code: source(
        "declare const body: unknown;",
        "declare function runCanvasUndoBatch(p: string, s: string, fn: () => void): void;",
        "const write = (): void => writePlainTextIntoBody(body, 'w');",
        "runCanvasUndoBatch('p', 's', write);",
      ),
      errors: [at(9, 27)],
    },
    {
      name: "L-23 a write after the gateway call, outside its callback",
      code: source(
        "writeSpaceDoc('n', { kind: 'delete' }, () => {});",
        "doc.transact(() => {});",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-24 an excepted function name in another file",
      filename: `${WEB}src/pages/project/chat/paste-canvas.ts`,
      code: source(
        "export function writeSnapshotNodes(): void {",
        "  doc.transact(() => {});",
        "}",
      ),
      errors: [at(8, 3)],
    },
    {
      name: "L-25 a function that is not excepted in canvas-space.ts",
      filename: `${WEB}src/data/yjs/canvas-space.ts`,
      code: source(
        "export function addNode(): void {",
        "  doc.transact(() => {});",
        "}",
      ),
      errors: [at(8, 3)],
    },
    {
      name: "L-26 a function that is not excepted in scene-document.ts",
      filename: `${WEB}src/data/yjs/scene-document.ts`,
      code: source(
        "export function otherSceneWrite(): void {",
        "  doc.transact(() => {});",
        "}",
      ),
      errors: [at(8, 3)],
    },
    {
      name: "L-27 an excepted method name in another file",
      filename: `${WEB}src/spaces/three-d/SceneEditor.tsx`,
      code: source(
        "export class SceneSession {",
        "  history = { undo(): void {}, redo(): void {} };",
        "  historyStep(direction: 'undo' | 'redo'): void {",
        "    this.history[direction]();",
        "  }",
        "}",
      ),
      errors: [at(10, 5)],
    },
    {
      name: "L-60 computed key 'undo'",
      code: source(
        "declare const x: Record<string, () => void>;",
        "x['undo']();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-61 computed key 'redo'",
      code: source(
        "declare const x: Record<string, () => void>;",
        "x['redo']();",
      ),
      errors: [at(8, 1)],
    },
    {
      name: "L-62 computed key named direction, whatever the receiver",
      code: source(
        "declare const stack: Record<string, () => void>;",
        "declare const direction: string;",
        "stack[direction]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-63 a receiver containing history, whatever the key",
      code: source(
        "declare const sceneHistory: Record<string, () => void>;",
        "declare const step: string;",
        "sceneHistory[step]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-64 history matched without regard to case",
      code: source(
        "declare const HISTORY: Record<string, () => void>;",
        "declare const step: string;",
        "HISTORY[step]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-65 a receiver containing undoManager",
      code: source(
        "declare const canvasUndoManager: Record<string, () => void>;",
        "declare const step: string;",
        "canvasUndoManager[step]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-66 this.history[step]() with a key that is not direction",
      code: source(
        "export class Player {",
        "  history = { undo(): void {}, redo(): void {} };",
        "  go(step: 'undo' | 'redo'): void {",
        "    this.history[step]();",
        "  }",
        "}",
      ),
      errors: [at(10, 5)],
    },
    {
      name: "L-67 doc['transact']",
      code: source("doc['transact'](() => {});"),
      errors: [at(7, 1)],
    },
    {
      name: "L-68 an aliased import is not a gateway (known limit)",
      code: source(
        "import { writeSpaceDoc as gate } from '@web/data/yjs/space-write';",
        "gate('n', { kind: 'add' }, () => { doc.transact(() => {}); });",
      ),
      errors: [at(8, 36)],
    },
    {
      name: "L-69 a member call is not a gateway (known limit)",
      code: source(
        "declare const spaceWrite: { writeSpaceDoc: typeof writeSpaceDoc };",
        "spaceWrite.writeSpaceDoc('n', { kind: 'add' }, () => { doc.transact(() => {}); });",
      ),
      errors: [at(8, 56)],
    },
    {
      name: "L-77 the first member undoManagerRef matches although the last is current",
      code: source(
        "declare const undoManagerRef: { current: Record<string, () => void> };",
        "declare const k: string;",
        "undoManagerRef.current[k]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-78 a middle member named history matches",
      code: source(
        "declare const store: { history: { entries: Record<string, () => void> } };",
        "declare const k: string;",
        "store.history.entries[k]();",
      ),
      errors: [at(9, 1)],
    },
    {
      name: "L-70 landHandlingContent is excepted only in canvas-space.ts",
      filename: `${WEB}src/data/yjs/node-storyboard.ts`,
      code: source(
        "declare const body: unknown;",
        "export function landHandlingContent(): void {",
        "  writePlainTextIntoBody(body, 'w');",
        "}",
      ),
      errors: [at(9, 3)],
    },
    {
      name: "L-71 writePlainTextIntoBody in a function of canvas-space.ts that is not excepted",
      filename: `${WEB}src/data/yjs/canvas-space.ts`,
      code: source(
        "declare const body: unknown;",
        "function seedBody(): void {",
        "  writePlainTextIntoBody(body, 'w');",
        "}",
      ),
      errors: [at(9, 3)],
    },
  ].map((testCase) => ({ ...testCase, options: [OPTION_E] })),
};

// The same five exception cases with an empty table: each is reported once.
const WITHOUT_EXCEPTIONS = {
  valid: [],
  invalid: EXCEPTION_CASES.map((exception) => ({
    name: `${exception.id} (empty exception table)`,
    filename: exception.filename,
    code: exception.code,
    options: [NO_EXCEPTIONS],
    errors: [exception.report],
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
  const ruleTester = new RuleTester({
    languageOptions: { globals: environment.globals },
  });
  ruleTester.run(
    `space-doc-write-gateway (${environment.name})`,
    spaceDocWriteGateway,
    CASES,
  );
  ruleTester.run(
    `space-doc-write-gateway without exceptions (${environment.name})`,
    spaceDocWriteGateway,
    WITHOUT_EXCEPTIONS,
  );
}

describe("space-doc-write-gateway options schema (L-80)", () => {
  /**
   * Lints a trivial file with the rule configured with one exception entry.
   * Flat-config `Linter` validates rule options against `meta.schema` and
   * throws on a mismatch.
   * @param exception The exception entry under test.
   * @returns The lint messages, when the options are accepted.
   * @throws {Error} When the options fail the rule's schema.
   */
  function lintWith(exception: Record<string, unknown>): Linter.LintMessage[] {
    const linter = new Linter();
    return linter.verify("export const a = 1;\n", [
      {
        plugins: {
          breatic: { rules: { "space-doc-write-gateway": spaceDocWriteGateway } },
        },
        rules: {
          "breatic/space-doc-write-gateway": [
            "error",
            { exceptions: [exception] },
          ],
        },
      },
    ]);
  }

  const COMPLETE = {
    file: "src/data/yjs/canvas-space.ts",
    function: "writeSnapshotNodes",
    reason: "A reason.",
  };

  it("accepts a complete exception entry", () => {
    // The control: without it, every rejection below could be the rule
    // failing to load rather than the schema refusing the entry.
    expect(lintWith(COMPLETE)).toEqual([]);
  });

  it.each([
    ["without reason", { file: COMPLETE.file, function: COMPLETE.function }],
    ["with an empty reason", { ...COMPLETE, reason: "" }],
    ["without file", { function: COMPLETE.function, reason: COMPLETE.reason }],
    ["without function", { file: COMPLETE.file, reason: COMPLETE.reason }],
  ])("rejects an exception %s", (_label, exception) => {
    expect(() => lintWith(exception)).toThrow(
      /breatic\/space-doc-write-gateway/,
    );
  });
});
