// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noNativeRenderedUi } from "../no-native-rendered-ui";

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

ruleTester.run("no-native-rendered-ui", noNativeRenderedUi, {
  valid: [
    { code: "export const A = () => <input type='text' autoComplete='off' />;" },
    { code: "export const A = () => <Input value={v} autoComplete='off' />;" },
    // A field whose remembered value is the point keeps its token.
    { code: "export const A = () => <Input type='email' autoComplete='email' />;" },
    // Types with no free-text history.
    { code: "export const A = () => <input type='checkbox' />;" },
    { code: "export const A = () => <input type='radio' />;" },
    { code: "export const A = () => <input type='file' />;" },
    { code: "export const A = () => <input type='hidden' />;" },
    { code: "export const A = () => <input type='submit' />;" },
    // A wrapper forwarding its props leaves the choice to its caller.
    { code: "export const A = (props) => <input type={props.type} {...props} />;" },
    // Our own components, distinguished by the capital letter.
    { code: "export const A = () => <Select><Option /></Select>;" },
    { code: "export const A = () => <Slider value={1} />;" },
    // Media without the control bar: we draw our own.
    { code: "export const A = () => <video src='x.mp4' />;" },
    // A justified exception on the same line.
    {
      code: "export const A = () => <input type='color' />; // native-ui:allow — the OS picker is the point here",
    },
    // A comment naming a banned form is documentation. The guard this
    // replaces needed an awk filter to skip these; the AST never sees them.
    { code: "// never write <select> or type='color' by hand\nexport const A = 1;" },
  ],
  invalid: [
    {
      // Without a token the browser offers every value ever typed into a
      // field of the same name, drawn in its own dropdown over our UI.
      code: "export const A = () => <input type='text' />;",
      errors: [{ messageId: "browserHistory", data: { control: "input" } }],
    },
    {
      code: "export const A = () => <input />;",
      errors: [{ messageId: "browserHistory", data: { control: "input" } }],
    },
    {
      code: "export const A = () => <Input id='studio-name' value={v} />;",
      errors: [{ messageId: "browserHistory", data: { control: "Input" } }],
    },
    {
      // A type decided at runtime may be a text one.
      code: "export const A = () => <Input type={kind} />;",
      errors: [{ messageId: "browserHistory", data: { control: "Input" } }],
    },
    {
      code: "export const A = () => <input type='color' />;",
      errors: [{ messageId: "nativeInputType", data: { type: "color" } }],
    },
    {
      code: "export const A = () => <input type='range' min={0} />;",
      errors: [{ messageId: "nativeInputType", data: { type: "range" } }],
    },
    {
      code: "export const A = () => <select><option /></select>;",
      errors: [{ messageId: "nativeControl", data: { control: "select" } }],
    },
    {
      code: "export const A = () => <video src='x.mp4' controls />;",
      errors: [{ messageId: "nativeControl", data: { control: "video" } }],
    },
    {
      code: "export const A = () => <audio src='x.mp3' controls />;",
      errors: [{ messageId: "nativeControl", data: { control: "audio" } }],
    },
    {
      // Markup assembled as a string reaches the DOM through innerHTML and
      // renders the same browser-drawn control. The guard this replaced read
      // lines of text and saw it; a rule that only visits JSX does not.
      code: 'el.innerHTML = "<select><option>a</option></select>";',
      errors: [{ messageId: "nativeControl", data: { control: "select" } }],
    },
    {
      code: "el.innerHTML = `<input type=\"color\" />`;",
      errors: [{ messageId: "nativeInputType", data: { type: "color" } }],
    },
    {
      code: 'el.innerHTML = "<video src=\'x.mp4\' controls></video>";',
      errors: [{ messageId: "nativeControl", data: { control: "video" } }],
    },
  ],
});
