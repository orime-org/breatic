// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noUpstreamLiteral } from "../no-upstream-literal";

const ruleTester = new RuleTester();

const options = [{ hosts: ["openrouter.ai", "fal.run", "api.wavespeed.ai"], names: ["openrouter", "wavespeed", "OPENROUTER_API_KEY"] }] as const;

/**
 * A case reporting one upstream name.
 * @param code - The source.
 * @param name - What it names.
 * @returns The invalid case.
 */
function names(code: string, name: string) {
  return { code, options, errors: [{ messageId: "upstreamName" as const, data: { name } }] };
}

ruleTester.run("no-upstream-literal", noUpstreamLiteral, {
  valid: [
    { code: `const served = result.servedBy;`, options },
    { code: `const name = "openrouter-like";`, options },
    { code: `import { relayMessages } from "@breatic/provider/messages";`, options },
    { code: `export { x } from "openrouter";`, options },
    { code: `const mod = await import("openrouter");`, options },
    { code: `// OpenRouter reports its own cost: openrouter.ai\nconst x = 1;`, options },
    { code: `const host = "https://example.com/openrouter";`, options },
    // A word excused in its own file, where it means something other than the upstream.
    { filename: "/repo/packages/worker/src/handlers/timeline/web-animation-execution.ts", code: `const legacy = "openrouter";`, options },
  ],
  invalid: [
    // A property value.
    names(`const call = { name: "openrouter" };`, "openrouter"),
    // A function argument.
    names(`record("wavespeed", cost);`, "wavespeed"),
    // A comparison with what a function returns.
    names(`if (providerOf(model) !== "openrouter") skip();`, "openrouter"),
    // A member name.
    names(`const cost = metadata?.openrouter?.usage;`, "openrouter"),
    // An object key, written bare or quoted.
    names(`const keys = { openrouter: 1 };`, "openrouter"),
    names(`const keys = { "wavespeed": 1 };`, "wavespeed"),
    names(`interface Keys { openrouter: string }`, "openrouter"),
    // A key variable's name.
    names(`const key = env["OPENROUTER_API_KEY"];`, "OPENROUTER_API_KEY"),
    names(`const key = env.OPENROUTER_API_KEY;`, "OPENROUTER_API_KEY"),
    // The same word in another file.
    { ...names(`const legacy = "openrouter";`, "openrouter"), filename: "/repo/packages/worker/src/handlers/dispatch.ts" },
    // A string type.
    names(`type Upstream = "wavespeed";`, "wavespeed"),
    {
      code: `const url = "https://openrouter.ai/api/v1/messages";`,
      options,
      errors: [{ messageId: "upstreamHost", data: { host: "openrouter.ai" } }],
    },
    {
      code: "const url = `https://queue.fal.run/${model}`;",
      options,
      errors: [{ messageId: "upstreamHost", data: { host: "fal.run" } }],
    },
  ],
});
