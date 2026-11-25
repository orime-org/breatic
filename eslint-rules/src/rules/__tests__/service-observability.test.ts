// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
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
    // Either may be reached through a namespace import.
    {
      filename: entry,
      code: `initLogger("collab");\ncore.startHealthServer(1);`,
    },
  ],
  invalid: [
    // Which files are service entries is the config's choice (`files`); a
    // service outside this repository's packages is held to the same rule.
    {
      filename: "/repo/packages/commerce/src/index.ts",
      code: `export const x = 1;`,
      errors: [
        { messageId: "noLogger" },
        { messageId: "noHealthServer" },
      ],
    },
    {
      filename: entry,
      code: `export const x = 1;`,
      errors: [
        { messageId: "noLogger" },
        { messageId: "noHealthServer" },
      ],
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
      errors: [
        { messageId: "noLogger" },
        { messageId: "noHealthServer" },
      ],
    },
    // A name mentioned in a comment or a string is not a call either.
    {
      filename: entry,
      code: `// createLogger("main") used to be here\nconst url = "https://x/startHealthServer";`,
      errors: [
        { messageId: "noLogger" },
        { messageId: "noHealthServer" },
      ],
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
