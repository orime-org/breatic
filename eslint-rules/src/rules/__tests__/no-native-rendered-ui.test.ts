// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noNativeRenderedUi } from "../no-native-rendered-ui";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

ruleTester.run("no-native-rendered-ui", noNativeRenderedUi, {
  valid: [
    { code: "export const A = () => <input type='text' />;" },
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
  ],
});
