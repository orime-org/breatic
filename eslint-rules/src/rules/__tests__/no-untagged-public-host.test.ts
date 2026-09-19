// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noUntaggedPublicHost } from "../no-untagged-public-host";

const ruleTester = new RuleTester();

ruleTester.run("no-untagged-public-host", noUntaggedPublicHost, {
  valid: [
    // Our own machine, whichever way it is written.
    { code: `await page.goto("http://localhost:5173/studio");` },
    { code: `await page.goto("http://127.0.0.1:3000/api");` },
    { code: "await page.goto(`http://localhost:${port}/studio`);" },
    // Reserved for documentation and tests by RFC 2606; nothing resolves.
    { code: `const link = "https://a.example/page";` },
    { code: `const link = "https://example.com/page";` },
    // A file the run built for itself.
    { code: `const src = "file:///tmp/fixture.png";` },
    // The host is reachable, and the case says so.
    {
      code: `test("ingests a url @needs-internet", async () => { await ingest("https://picsum.photos/200"); });`,
    },
    // The declaration can sit at the top of the file too.
    {
      code: `test.describe("media @needs-internet", () => { const IMG = "https://picsum.photos/200"; });`,
    },
    // A path with no host is ours.
    { code: `await page.goto("/studio");` },
  ],
  invalid: [
    {
      code: `const IMG = "https://picsum.photos/200";`,
      errors: [{ messageId: "untaggedHost", data: { host: "picsum.photos" } }],
    },
    {
      code: `test("ingests a url", async () => { await ingest("https://test-videos.co.uk/x.mp4"); });`,
      errors: [
        { messageId: "untaggedHost", data: { host: "test-videos.co.uk" } },
      ],
    },
    // A different service's tag does not cover reaching the public internet.
    {
      code: `test("a case @needs-model", async () => { await ingest("https://www.kozco.com/a.wav"); });`,
      errors: [{ messageId: "untaggedHost", data: { host: "www.kozco.com" } }],
    },
    // Template literals are how a url gets assembled.
    {
      code: "const IMG = `https://upload.wikimedia.org/${path}`;",
      errors: [{ messageId: "untaggedHost" }],
    },
  ],
});
