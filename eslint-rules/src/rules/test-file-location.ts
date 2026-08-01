// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** A test file by name. */
const TEST_FILE = /\.(test|spec)\.tsx?$/;

/** The one directory tests live in. */
const TEST_DIR = "__tests__";

/**
 * Tests live in a `__tests__` directory beside what they test.
 *
 * One location means a reader always knows where to look, and a directory
 * rather than a suffix keeps source listings free of test files. There is no
 * second option: a colocated `foo.test.ts` next to `foo.ts` is the shape
 * this rule exists to prevent.
 *
 * Moving a test into `__tests__` deepens its relative imports by one level.
 * The mock paths go with them — `vi.mock("./y")` takes a path argument that
 * is easy to miss, and a stale one fails at runtime rather than at compile
 * time.
 */
export const testFileLocation = createRule({
  name: "test-file-location",
  meta: {
    type: "problem",
    docs: { description: "Tests live in a __tests__ directory" },
    schema: [],
    messages: {
      wrongLocation:
        "A test file belongs in a __tests__ directory beside what it tests, not alongside the source. Remember to deepen the relative imports — including the paths inside vi.mock().",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(node: TSESTree.Program): void {
        // Normalised the way every other path-reading rule here does it:
        // the filename arrives with the platform's separator, and a rule
        // that split on "/" alone would see one long segment on Windows and
        // report every correctly-placed test file.
        const path = context.filename.replace(/\\/g, "/");
        if (!TEST_FILE.test(path)) return;
        if (path.split("/").includes(TEST_DIR)) return;
        context.report({ node, messageId: "wrongLocation" });
      },
    };
  },
});
