// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { serviceObservability } from "../service-observability";

const ruleTester = new RuleTester();

const entry = "/repo/packages/collab/src/index.ts";

ruleTester.run("service-observability", serviceObservability, {
  valid: [
    {
      filename: entry,
      code: `initLogger("collab");\nstartHealthServer(1235);`,
    },
    {
      filename: "/repo/packages/server/src/index.ts",
      code: `const log = createLogger("server");\nstartHealthServer(3001);`,
    },
    {
      filename: "/repo/packages/worker/src/index.ts",
      code: `logger.info("up");\nstartHealthServer(9101);`,
    },
    // A child or scoped logger reads through a member.
    {
      filename: entry,
      code: `deps.logger.warn("x");\nstartHealthServer(1);`,
    },
    // Not a service entry: this rule has nothing to say about it.
    {
      filename: "/repo/packages/core/src/index.ts",
      code: `export const x = 1;`,
    },
    {
      filename: "/repo/packages/server/src/routes/assets.ts",
      code: `export const x = 1;`,
    },
  ],
  invalid: [
    {
      filename: entry,
      code: `export const x = 1;`,
      errors: [{ messageId: "noLogger" }, { messageId: "noHealthServer" }],
    },
    {
      filename: entry,
      code: `initLogger("collab");`,
      errors: [{ messageId: "noHealthServer" }],
    },
    {
      filename: entry,
      code: `startHealthServer(1235);`,
      errors: [{ messageId: "noLogger" }],
    },
    // An import is not a wire. The guard this replaces matched text, so a
    // file containing only these two imports satisfied it.
    {
      filename: entry,
      code: `import { startHealthServer, createLogger } from "@breatic/core";`,
      errors: [{ messageId: "noLogger" }, { messageId: "noHealthServer" }],
    },
    // A name mentioned in a comment or a string is not a call either.
    {
      filename: entry,
      code: `// createLogger("main") used to be here\nconst url = "https://x/startHealthServer";`,
      errors: [{ messageId: "noLogger" }, { messageId: "noHealthServer" }],
    },
    // console is not a logger — another rule bans it in libraries, and
    // counting it here would let one rule satisfy what another forbids.
    {
      filename: entry,
      code: `console.info("up");\nstartHealthServer(1);`,
      errors: [{ messageId: "noLogger" }],
    },
  ],
});
