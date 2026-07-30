// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noDeployedHost } from "../no-deployed-host";

const ruleTester = new RuleTester();

ruleTester.run("no-deployed-host", noDeployedHost, {
  valid: [
    { code: `const apiTarget = "http://localhost:5173";` },
    { code: "const apiTarget = `http://localhost:${port}`;" },
    { code: `const apiTarget = env.PUBLIC_URL;` },
    // A comment naming the host is the explanation, not the violation. The
    // guard this replaces needed a quote-class regex to tell them apart,
    // and still matched backticks inside doc comments.
    {
      code: `// Pointing these at thinkai.cc / breatic.ai routes traffic to shared infra\nconst t = "http://localhost:3000";`,
    },
    {
      code: `/** Full landing link, e.g. \`https://breatic.ai/studio-invite\`. */\nconst x = 1;`,
    },
    // A near-miss host is a different domain.
    { code: `const t = "https://thinkai.example";` },
  ],
  invalid: [
    {
      code: `const apiTarget = "https://www.thinkai.cc";`,
      errors: [{ messageId: "deployedHost", data: { host: "thinkai.cc" } }],
    },
    {
      code: `const apiTarget = 'https://breatic.ai';`,
      errors: [{ messageId: "deployedHost", data: { host: "breatic.ai" } }],
    },
    // A template literal is how a target gets assembled, so it counts too.
    {
      code: "const apiTarget = `https://api.thinkai.cc/${path}`;",
      errors: [{ messageId: "deployedHost" }],
    },
    // The shape the proxy config actually takes.
    {
      code: `export const proxy = { "/api": { target: "https://thinkai.cc", changeOrigin: true } };`,
      errors: [{ messageId: "deployedHost" }],
    },
    // Split across a config object, both reported.
    {
      code: `const t = { api: "https://thinkai.cc", ws: "wss://breatic.ai" };`,
      errors: [{ messageId: "deployedHost" }, { messageId: "deployedHost" }],
    },
  ],
});
