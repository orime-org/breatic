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
    // A size the rule cannot read is left alone, the same way an unreadable
    // variant is. Guessing "default" here reported icon buttons that comply.
    {
      code: "export const S = () => <Button variant='ghost' size={compact ? 'icon' : 'chrome'}><X /></Button>;",
    },
    // A control framed by whatever encloses it says so on the line, the same
    // way no-native-rendered-ui spells its exception.
    {
      code: "export const W = () => (\n  <Button\n    // bordered-button:allow — the node shell draws the frame\n    variant='ghost'\n    size='sm'\n  >\n    Drop a file\n  </Button>\n);",
    },
    // An icon size on a button with no words is what the allowance is for.
    {
      code: "export const Y = () => <Button variant='ghost' size='icon' aria-label='Close'><X /></Button>;",
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
    // `link` draws neither a border nor a fill either, so it belongs in the
    // same set. Nothing uses it today, which is exactly why it would be the
    // spelling someone reaches for once `ghost` starts failing CI.
    {
      code: "export const F = () => <Button variant='link' size='sm'>Cancel</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // One backtick with no holes is the same constant written differently.
    {
      code: "export const G = () => <Button variant={`ghost`} size='sm'>Revoke</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // A marker somewhere else in the file does not excuse this line.
    {
      code: "// bordered-button:allow\nexport const X = () => <Button variant='ghost' size='sm'>Revoke</Button>;",
      errors: [{ messageId: "borderless", line: 2 }],
    },
    // `size='icon'` is allowed because a glyph-only button has no word to
    // mistake for prose. Declaring the size while rendering a word is the
    // one-token way to silence the rule, so the premise is now checked.
    {
      code: "export const Z1 = () => <Button variant='ghost' size='icon'>Save</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    {
      code: "export const Z2 = () => <Button variant='ghost' size='chrome'>{t('a.b')}</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // An alias is the same import. Matching the bare name `Button` let a file
    // that renames it on the way in opt out of the rule entirely.
    {
      code: "import { Button as B } from '@web/components/ui/button';\nexport const Z3 = () => <B variant='ghost' size='sm'>Save</B>;",
      errors: [{ messageId: "borderless", line: 2 }],
    },
    // `as const` is ordinary TypeScript, not an attack — but it hid the variant.
    {
      code: "export const Z4 = () => <Button variant={'ghost' as const} size='sm'>Save</Button>;",
      errors: [{ messageId: "borderless", line: 1 }],
    },
    // A marker at the end of a line must not excuse an element that merely
    // shares that line; the exception is per button, not per line.
    {
      code: "export const Z5 = () => (\n  <div>\n    <Button variant='ghost' size='sm'>A</Button> {/* bordered-button:allow */}\n  </div>\n);",
      errors: [{ messageId: "borderless", line: 3 }],
    },
  ],
});
