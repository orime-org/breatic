// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { borderedTextButton } from "../bordered-text-button";

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

ruleTester.run("bordered-text-button", borderedTextButton, {
  valid: [
    // A row in a dropdown reads as pressable from its full width and its
    // hover highlight; a border around each row would break the menu.
    {
      code: "export const M = () => <Button variant='ghost' size='menu-item'>Sign out</Button>;",
    },
    // An icon button's shape is the affordance.
    {
      code: "export const I = () => <Button variant='ghost' size='icon'><X /></Button>;",
    },
    // Chrome buttons are the 32-square icon form; their label is an aria-label.
    {
      code: "export const C = () => <Button variant='chrome-ghost' size='chrome' aria-label='Share'><Share /></Button>;",
    },
    // Outline already carries the border this rule is about.
    {
      code: "export const O = () => <Button variant='outline' size='sm'>Cancel</Button>;",
    },
    // No variant means the default one, which has a solid background.
    { code: "export const D = () => <Button size='sm'>Save</Button>;" },
    // A variant the rule cannot read statically still passes on its size —
    // toggle buttons write `active ? 'secondary' : 'ghost'` and are icons.
    {
      code: "export const T = () => <Button variant={active ? 'secondary' : 'ghost'} size='icon'><Pen /></Button>;",
    },
    // Some other component's `variant` prop is not this rule's business.
    {
      code: "export const R = () => <NodeResizeControl variant='ghost' size='sm' />;",
    },
  ],
  invalid: [
    // The shape this rule exists for: a word on a page with nothing around it.
    {
      code: "export const A = () => <Button variant='ghost' size='sm'>Revoke</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // No size at all is the default 32px text button — same problem.
    {
      code: "export const B = () => <Button variant='ghost'>Revoke</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // Written as an expression container, still a literal the rule can read.
    {
      code: "export const C = () => <Button variant={'ghost'} size='sm'>Revoke</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // The chrome variant is borderless too; it is only legal at icon sizes.
    {
      code: "export const D = () => <Button variant='chrome-ghost' size='sm'>Share</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // A size that is not on the allowlist is a violation even if it is new —
    // this is the case a `ghost + sm` blocklist would have let through.
    {
      code: "export const E = () => <Button variant='ghost' size='lg'>Continue</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
  ],
});
