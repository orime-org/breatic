// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { declaredScenarioTags } from "../declared-scenario-tags";

const ruleTester = new RuleTester();

ruleTester.run("declared-scenario-tags", declaredScenarioTags, {
  valid: [
    { code: `test("a case @needs-model", async () => {});` },
    // Two services, both declared.
    { code: `test("a case @needs-ingest @needs-storage", async () => {});` },
    // No tag at all is the common case.
    { code: `test("a case", async () => {});` },
    // A tag that is not a scenario tag belongs to somebody else.
    { code: `test("a case @slow", async () => {});` },
    // The prefix inside a word is not a tag.
    { code: `const note = "cases@needs-model-review are listed below";` },
  ],
  invalid: [
    {
      code: `test("a case @needs-modell", async () => {});`,
      errors: [{ messageId: "undeclaredTag", data: { tag: "@needs-modell" } }],
    },
    // A service nobody declared, spelt perfectly.
    {
      code: `test("a case @needs-stripe", async () => {});`,
      errors: [{ messageId: "undeclaredTag", data: { tag: "@needs-stripe" } }],
    },
    // One good, one bad: only the bad one is reported.
    {
      code: `test("a case @needs-model @needs-redis", async () => {});`,
      errors: [{ messageId: "undeclaredTag", data: { tag: "@needs-redis" } }],
    },
    // The tag list form Playwright also accepts.
    {
      code: `test("a case", { tag: "@needs-webhooks" }, async () => {});`,
      errors: [{ messageId: "undeclaredTag", data: { tag: "@needs-webhooks" } }],
    },
  ],
});
