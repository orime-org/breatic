// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { onePxBorder } from "../one-px-border";

const ruleTester = new RuleTester();

ruleTester.run("one-px-border", onePxBorder, {
  valid: [
    { code: "export const c = 'border border-border';" },
    { code: "export const c = 'ring-1 ring-ring';" },
    { code: "export const c = 'border-1';" },
    // Two or more digits are outside the pattern: the ban is written for
    // single-digit widths, and widening it would start failing code that
    // passes today.
    { code: "export const c = 'ring-10';" },
    { code: "export const c = 'border-12';" },
    // A hyphen on the left is not a class boundary.
    { code: "export const c = 'x-border-2';" },
    { code: "export const c = 'border-[1.5px]';" },
  ],
  invalid: [
    { code: "export const c = 'border-2';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'rounded ring-2 ring-ring';", errors: [{ messageId: "forbiddenClass" }] },
    // Variant prefixes end in a colon, which is a boundary.
    { code: "export const c = 'focus-visible:ring-2';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'border-t-2';", errors: [{ messageId: "forbiddenClass" }] },
    // The offset alternative has no boundaries on either side.
    { code: "export const c = 'ring-offset-2 ring-offset-background';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'border-[2px]';", errors: [{ messageId: "forbiddenClass" }] },
  ],
});
