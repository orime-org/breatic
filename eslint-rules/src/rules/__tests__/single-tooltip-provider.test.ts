// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { singleTooltipProvider } from "../single-tooltip-provider";

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

ruleTester.run("single-tooltip-provider", singleTooltipProvider, {
  valid: [
    // A Tooltip inherits the app-level provider; nothing else is needed.
    { code: "export const T = () => <Tooltip><TooltipTrigger /></Tooltip>;" },
    // Re-exporting the primitive is not rendering it. The vendor file does
    // exactly this, plus JSDoc examples that the AST never sees.
    { code: "const TooltipProvider = Primitive.Provider;\nexport { TooltipProvider };" },
  ],
  invalid: [
    {
      code: "export const P = () => <TooltipProvider delayDuration={300}><X /></TooltipProvider>;",
      errors: [{ messageId: "nestedProvider", line: 1, column: 24 }],
    },
    {
      code: "export const P = () => <TooltipProvider />;",
      errors: [{ messageId: "nestedProvider", line: 1, column: 24 }],
    },
  ],
});
