// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { overlaySurface } from "../overlay-surface";

const ruleTester = new RuleTester();

const panel = "/repo/packages/web/src/components/ui/dialog.tsx";
const float = "/repo/packages/web/src/components/ui/popover.tsx";

ruleTester.run("overlay-surface", overlaySurface, {
  valid: [
    { filename: panel, code: `const c = "border border-border bg-card p-0";` },
    { filename: float, code: `const c = "rounded-overlay bg-popover p-4";` },
    // bg-background is allowed on both families.
    { filename: panel, code: `const c = "bg-background";` },
    { filename: float, code: `const c = "bg-background";` },
    // Menu-item hover fills are not panel surfaces.
    { filename: float, code: `const c = "hover:bg-muted focus:bg-accent";` },
    // The foreground token is a text colour, not a surface.
    { filename: float, code: `const c = "bg-popover text-popover-foreground";` },
    // A file in neither family is not this rule's business.
    {
      filename: "/repo/packages/web/src/components/ui/tooltip.tsx",
      code: `const c = "bg-foreground bg-card bg-popover";`,
    },
    {
      filename: "/repo/packages/web/src/spaces/canvas/Node.tsx",
      code: `const c = "bg-popover";`,
    },
    // A comment naming the other family's surface is documentation.
    {
      filename: float,
      code: `// an earlier attempt used bg-card here\nconst c = "bg-popover";`,
    },
  ],
  invalid: [
    {
      filename: panel,
      code: `const c = "z-50 bg-popover p-6";`,
      errors: [
        {
          messageId: "wrongSurface",
          data: {
            match: "bg-popover",
            family: "content panels",
            expected: "bg-card",
          },
        },
      ],
    },
    {
      filename: panel,
      code: `const c = "bg-elevated";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: float,
      code: `const c = "rounded-overlay bg-card p-1";`,
      errors: [
        {
          messageId: "wrongSurface",
          data: {
            match: "bg-card",
            family: "anchored floats",
            expected: "bg-popover",
          },
        },
      ],
    },
    {
      filename: float,
      code: `const c = "bg-elevated";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    // Every listed component is covered, not just the two probed above.
    {
      filename: "/repo/packages/web/src/components/ui/sheet.tsx",
      code: `const c = "bg-popover";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: "/repo/packages/web/src/components/ui/alert-dialog.tsx",
      code: `const c = "bg-popover";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: "/repo/packages/web/src/components/ui/dropdown-menu.tsx",
      code: `const c = "bg-card";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: "/repo/packages/web/src/components/ui/context-menu.tsx",
      code: `const c = "bg-card";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: "/repo/packages/web/src/components/ui/select.tsx",
      code: `const c = "bg-card";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: "/repo/packages/web/src/components/ui/command.tsx",
      code: `const c = "bg-card";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    {
      filename: "/repo/packages/web/src/components/ui/sonner.tsx",
      code: `const c = "bg-card";`,
      errors: [{ messageId: "wrongSurface" }],
    },
    // Inside a template literal, which is how conditional class lists are built.
    {
      filename: panel,
      code: "const c = `z-50 bg-popover ${extra}`;",
      errors: [{ messageId: "wrongSurface" }],
    },
  ],
});
