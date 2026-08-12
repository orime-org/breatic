// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { eagerConfigLoad } from "../eager-config-load";

const ruleTester = new RuleTester();

const entry = "/repo/packages/collab/src/index.ts";
const serverEntry = "/repo/packages/server/src/index.ts";

ruleTester.run("eager-config-load", eagerConfigLoad, {
  valid: [
    {
      filename: entry,
      code: `import { getMembershipConfig } from "@breatic/core";\ngetMembershipConfig();`,
    },
    // The shape all three entries actually use: the library throws, the entry
    // logs and exits. A try block is still module top level.
    {
      filename: entry,
      code: `import { getMembershipConfig } from "@breatic/core";\ntry {\n  getMembershipConfig();\n} catch (err) {\n  logger.error({ err }, "bad");\n  process.exit(1);\n}`,
    },
    // Several loaders, all warmed. The rule asks each import its own
    // question, so this is what it takes for server to pass today.
    {
      filename: serverEntry,
      code: `import { getSkillRouting, getStorageConfig, getMembershipConfig } from "@breatic/core";\ngetSkillRouting();\ngetStorageConfig();\ngetMembershipConfig();`,
    },
    // Renamed on import: the requirement follows the original export name,
    // and is satisfied by a call under the local one.
    {
      filename: entry,
      code: `import { getMembershipConfig as loadQuotas } from "@breatic/core";\nloadQuotas();`,
    },
    // Importing something that is not a lazy config loader asks nothing.
    {
      filename: entry,
      code: `import { startHealthServer } from "@breatic/core";\nstartHealthServer(1235);`,
    },
    // Not a service entry. Every other file in the repo calls these lazily on
    // purpose — that is the point of memoizing them.
    {
      filename: "/repo/packages/server/src/routes/assets.ts",
      code: `import { getStorageConfig } from "@breatic/core";\nexport function h() { return getStorageConfig(); }`,
    },
    {
      filename: "/repo/packages/core/src/index.ts",
      code: `import { getMembershipConfig } from "@breatic/core";\nexport const x = () => getMembershipConfig();`,
    },
  ],
  invalid: [
    // The regression this exists for: somebody reads a call whose return
    // value is discarded as dead code and deletes it. Nothing breaks until a
    // config file is edited wrongly months later.
    {
      filename: entry,
      code: `import { getMembershipConfig } from "@breatic/core";\nstartHealthServer(1235);`,
      errors: [{ messageId: "notLoadedEagerly" }],
    },
    // Each import is judged on its own. Warming one loader says nothing about
    // the one beside it — which is exactly what the previous single-name rule
    // got wrong: two of server's three loads were unguarded.
    {
      filename: serverEntry,
      code: `import { getSkillRouting, getStorageConfig, getMembershipConfig } from "@breatic/core";\ngetMembershipConfig();`,
      errors: [
        { messageId: "notLoadedEagerly" },
        { messageId: "notLoadedEagerly" },
      ],
    },
    // Called, but inside a function. Whether anything ever calls that
    // function is not a question one file can answer, and a call that never
    // runs loads nothing at boot.
    {
      filename: entry,
      code: `import { getMembershipConfig } from "@breatic/core";\nfunction boot() {\n  getMembershipConfig();\n}`,
      errors: [{ messageId: "notLoadedEagerly" }],
    },
    // Inside an arrow assigned to a const: still not top level.
    {
      filename: entry,
      code: `import { getStorageConfig } from "@breatic/core";\nconst warm = () => getStorageConfig();`,
      errors: [{ messageId: "notLoadedEagerly" }],
    },
    // A mention is not a call, same as its sibling rule.
    {
      filename: entry,
      code: `import { getMembershipConfig } from "@breatic/core";\n// getMembershipConfig() used to be here\nconst s = "getMembershipConfig()";`,
      errors: [{ messageId: "notLoadedEagerly" }],
    },
    // Renamed on import and never called under either name.
    {
      filename: entry,
      code: `import { getMembershipConfig as loadQuotas } from "@breatic/core";\ngetMembershipConfig();`,
      errors: [{ messageId: "notLoadedEagerly" }],
    },
  ],
});
