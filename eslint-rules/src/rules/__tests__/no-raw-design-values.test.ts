// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRawDesignValues } from "../no-raw-design-values";
import { noRawHexColor } from "../no-raw-hex-color";

const ruleTester = new RuleTester();

ruleTester.run("no-raw-design-values", noRawDesignValues, {
  valid: [
    { code: "export const c = 'text-sm rounded-content-sm';" },
    // Consuming a token through an arbitrary value is how tokens are used.
    { code: "export const c = 'h-[var(--btn-chrome)]';" },
    { code: "export const c = 'rounded-[var(--radius-content-sm)]';" },
    // Geometry off the button ladder is unconstrained.
    { code: "export const c = 'w-[420px] gap-[7px]';" },
    // The escape hatch, with its reason on the same line.
    {
      code: "export const c = 'text-[13px]'; // design-value: allow — matches the embedded editor's own metrics",
    },
  ],
  invalid: [
    { code: "export const c = 'text-[13px]';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'rounded-[6px]';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'bg-[var(--neutral-200)]';", errors: [{ messageId: "forbiddenClass" }] },
    // On the button ladder.
    { code: "export const c = 'h-[32px]';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'min-w-[44px]';", errors: [{ messageId: "forbiddenClass" }] },
  ],
});

ruleTester.run("no-raw-hex-color", noRawHexColor, {
  valid: [
    { code: "export const c = 'bg-background text-foreground';" },
    // Three-digit hex is outside the pattern, as it was before.
    { code: "export const c = '#abc';" },
    {
      code: "export const c = '#ff0000'; // design-value: allow — the brush pigment is fixed",
    },
  ],
  invalid: [
    { code: "export const c = '#ff0000';", errors: [{ messageId: "forbiddenClass" }] },
    { code: "export const c = 'shadow-[0_0_0_1px_#1a1a1a]';", errors: [{ messageId: "forbiddenClass" }] },
  ],
});
