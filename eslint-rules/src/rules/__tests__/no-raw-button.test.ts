// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRawButton } from "../no-raw-button";

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

ruleTester.run("no-raw-button", noRawButton, {
  valid: [
    { code: "export const A = () => <Button>Save</Button>;" },
    // A trigger another primitive owns still goes through Button.
    {
      code: "export const B = () => <PopoverTrigger asChild><Button variant='outline'>Open</Button></PopoverTrigger>;",
    },
    // Other elements are not this rule's business, including ones whose name
    // merely contains the word.
    { code: "export const C = () => <ButtonGroup><Button>x</Button></ButtonGroup>;" },
    { code: "export const D = () => <div role='button'>Save</div>;" },
  ],
  invalid: [
    { code: "export const E = () => <button type='button'>Save</button>;", errors: [{ messageId: "rawButton", line: 1 }] },
    // Icon-only counts: the point is one spelling, not one appearance.
    {
      code: "export const F = () => <button type='button' aria-label='Close'><X /></button>;",
      errors: [{ messageId: "rawButton", line: 1 }],
    },
    // A hit area with nothing inside counts too.
    { code: "export const G = () => <button className='absolute inset-0' />;", errors: [{ messageId: "rawButton", line: 1 }] },
    // A tab is a role on a Button, not a different element.
    {
      code: "export const H = () => <button role='tab'>Canvas</button>;",
      errors: [{ messageId: "rawButton", line: 1 }],
    },
    // The element built through the factory is the same element.
    {
      code: "export const I = () => React.createElement('button', { type: 'button' }, 'Save');",
      errors: [{ messageId: "rawButton", line: 1 }],
    },
    {
      code: "export const J = () => createElement('button', null, 'Save');",
      errors: [{ messageId: "rawButton", line: 1 }],
    },
  ],
});
