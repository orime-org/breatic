// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { hoverPattern } from "../hover-pattern";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("hover-pattern", hoverPattern, {
  valid: [
    { code: "export const c = 'hover:bg-muted';" },
    { code: "export const c = 'hover:opacity-90';" },
    // Scrims over media: the image is meant to show through.
    { code: "export const c = 'bg-black/45 hover:bg-black/70';" },
    { code: "export const c = 'hover:bg-white/20';" },
    // Single-digit alpha is outside the ban, which requires two digits.
    { code: "export const c = 'hover:bg-muted/5';" },
  ],
  invalid: [
    {
      code: "export const c = 'rounded hover:bg-muted/50';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      code: "export const c = `flex hover:bg-accent/70 ${extra}`;",
      errors: [{ messageId: "forbiddenClass" }],
    },
  ],
});
