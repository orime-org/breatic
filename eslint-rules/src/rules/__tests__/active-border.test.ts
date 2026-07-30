// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { activeBorder } from "../active-border";

const ruleTester = new RuleTester();

ruleTester.run("active-border", activeBorder, {
  valid: [
    { code: "export const c = 'focus-visible:border-active-border';" },
    // A neutral border with no state variant is just a border.
    { code: "export const c = 'border-foreground';" },
    // A state variant on something that is not a border colour.
    { code: "export const c = 'focus:bg-accent';" },
    // Colour-semantic borders are a separate system.
    { code: "export const c = 'data-[state=checked]:border-status-success';" },
  ],
  invalid: [
    {
      code: "export const c = 'focus-visible:border-primary';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      code: "export const c = 'data-[state=active]:border-foreground';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      // Group and peer prefixes have no left boundary in the pattern, so
      // they match by substring — as they did before.
      code: "export const c = 'group-focus-visible:border-muted-foreground';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      code: "export const c = 'aria-selected:border-input';",
      errors: [{ messageId: "forbiddenClass" }],
    },
  ],
});
