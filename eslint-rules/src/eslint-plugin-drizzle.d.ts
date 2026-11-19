// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// eslint-plugin-drizzle ships no type declarations; this is the one shape
// `backend-config.ts` uses it in.
declare module "eslint-plugin-drizzle" {
  import type { TSESLint } from "@typescript-eslint/utils";

  const plugin: TSESLint.FlatConfig.Plugin;
  export default plugin;
}
