// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noInlineScrollbar } from "../no-inline-scrollbar";

const ruleTester = new RuleTester();

ruleTester.run("no-inline-scrollbar", noInlineScrollbar, {
  valid: [
    { code: "export const c = 'flex flex-col gap-2';" },
    // A deliberately hidden bar: nothing for an engine to draw differently.
    // This is the real SpaceTabBar string, where the exemption sits
    // alongside an overflow utility and a webkit pseudo.
    {
      code: "export const c = 'flex flex-1 items-center overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';",
    },
    // Hiding the bar through the webkit pseudo alone is the one permitted
    // spelling — it is removed before the pattern is tested.
    { code: "export const c = '[&::-webkit-scrollbar]:hidden';" },
  ],
  invalid: [
    {
      code: "export const c = 'h-full overflow-y-auto';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      code: "export const c = '[&::-webkit-scrollbar]:w-2';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      // The permitted spelling is stripped, but the rest still counts.
      code: "export const c = '[&::-webkit-scrollbar]:hidden overflow-auto';",
      errors: [{ messageId: "forbiddenClass" }],
    },
    {
      code: "export const c = '[scrollbar-color:red]';",
      errors: [{ messageId: "forbiddenClass" }],
    },
  ],
});
