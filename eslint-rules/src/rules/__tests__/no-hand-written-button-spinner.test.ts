// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noHandWrittenButtonSpinner } from "../no-hand-written-button-spinner";

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

ruleTester.run("no-hand-written-button-spinner", noHandWrittenButtonSpinner, {
  valid: [
    { code: "export const A = () => <Button loading>Save</Button>;" },
    { code: "export const B = () => <Button loading icon={<ArrowUp />} aria-label='Go' />;" },
    // A spinner that is not inside a button is a loading row, not a button state.
    { code: "export const C = () => <div><Loader2 className='animate-spin' />Loading</div>;" },
    { code: "export const D = () => <span data-testid='sending'><Loader2 /></span>;" },
    // A name that merely contains the word is another element.
    { code: "export const E = () => <ButtonGroup><Loader2 /></ButtonGroup>;" },
    // A tab reports activity elsewhere while its navigation stays enabled.
    { code: 'export const Tab = () => <Button role="tab"><Loader2 /></Button>;' },
    { code: "export const Tab = () => <Button role={'tab'}><span><Loader2 /></span></Button>;" },
    { code: 'export const Tab = () => <Button role="tab" icon={<Loader2 />}>Space</Button>;' },
    { code: 'export const Tab = () => <Button {...props} role="tab"><Loader2 /></Button>;' },
  ],
  invalid: [
    {
      code: 'export const Tab = () => <Button role={role}><Loader2 /></Button>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: 'export const Action = () => <Button role="button"><Loader2 /></Button>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: 'export const Tab = () => <Button role="tab" {...props}><Loader2 /></Button>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: 'export const Action = () => <AlertDialogAction role="tab"><Loader2 /></AlertDialogAction>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: 'export const Tab = () => <Button role="tab"><Button><Loader2 /></Button></Button>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: 'export const Action = () => <Button><Button role="tab"><Loader2 /></Button></Button>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: 'export const Action = () => <Button><span role="tab"><Loader2 /></span></Button>;',
      errors: [{ messageId: "handWrittenSpinner" }],
    },
    {
      code: "export const F = () => <Button disabled={busy}>{busy ? <Loader2 className='mr-2 h-3.5 w-3.5 animate-spin' /> : null}Pay</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    {
      code: "export const G = () => <Button>{pending ? <Loader2 /> : <ArrowUp />}</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    // Nested deeper inside the button still renders inside it.
    {
      code: "export const H = () => <Button><span><Loader2 /></span>Save</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    // The icon slot is inside the button too.
    {
      code: "export const I = () => <Button icon={<Loader2 className='animate-spin' />}>Save</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    {
      code: "export const J = () => <AlertDialogAction><Loader2 />Delete</AlertDialogAction>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    // The same lucide icon under its other export names.
    {
      code: "export const K = () => <Button><LoaderCircle />Save</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    {
      code: "export const L = () => <Button><LucideLoader2 />Save</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
    {
      code: "export const M = () => <Button><LucideLoaderCircle />Save</Button>;",
      errors: [{ messageId: "handWrittenSpinner", line: 1 }],
    },
  ],
});
