// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { stringLiteralVisitors } from "#rules/source-visitors";
import { createRule } from "#rules/create-rule";

/** What the configuration says an upstream is: the hosts it is reached at, and its names and key variables. */
interface Options {
  hosts: readonly string[];
  names: readonly string[];
}

/**
 * The places the same word means something other than the upstream, each with why. A word is excused only in its
 * file, so the same word anywhere else is still reported.
 */
const EXCUSED: ReadonlyArray<{ file: string; name: string; reason: string }> = [
  { file: "packages/ingest/container/web-animation-package.ts", name: "DEEPSEEK_API_KEY", reason: "the DeepSeek Harness's own variable: its value is a placeholder, and the relay sends the real key" },
  { file: "packages/shared/src/timeline/web-animation.ts", name: "deepseek", reason: "the web-animation engine a user picks" },
  { file: "packages/shared/src/types/entities.ts", name: "deepseek", reason: "the web-animation engine a user picks" },
  { file: "packages/web/src/spaces/timeline/TimelineSpace.tsx", name: "deepseek", reason: "the web-animation engine a user picks" },
  { file: "packages/web/src/spaces/timeline/TimelineWebAnimationDialog.tsx", name: "deepseek", reason: "the web-animation engine a user picks" },
  { file: "packages/server/src/modules/auth/auth.service.ts", name: "google", reason: "Google sign-in" },
  { file: "packages/server/src/routes/auth.ts", name: "google", reason: "Google sign-in" },
  { file: "packages/web/src/data/api/auth.ts", name: "google", reason: "Google sign-in" },
  { file: "packages/web/src/pages/auth/LoginPage.tsx", name: "google", reason: "Google sign-in" },
  { file: "packages/web/src/pages/auth/RegisterPage.tsx", name: "google", reason: "Google sign-in" },
  { file: "packages/web/src/spaces/canvas/generate/ModelIcon.tsx", name: "openai", reason: "a brand icon's key" },
  {
    file: "packages/worker/src/handlers/timeline/web-animation-execution.ts",
    name: "openrouter",
    reason: "who served a call from a Worker deployed before the plan, which sends every call to OpenRouter (inner#1743)",
  },
];

/**
 * Whether a word is excused in this file.
 * @param filename The linted file's path.
 * @param name The word.
 * @returns True when the file is one where the word means something else.
 */
function isExcused(filename: string, name: string): boolean {
  const path = filename.replace(/\\/g, "/");
  return EXCUSED.some((entry) => entry.name === name && path.endsWith(`/${entry.file}`));
}

/**
 * Whether a string literal is the specifier of an import or export, which names a package, not an upstream.
 * @param node The literal.
 * @returns True for a module specifier.
 */
function isModuleSource(node: TSESTree.Node): boolean {
  const parent = node.parent;
  return (
    (parent?.type === AST_NODE_TYPES.ImportDeclaration ||
      parent?.type === AST_NODE_TYPES.ExportNamedDeclaration ||
      parent?.type === AST_NODE_TYPES.ExportAllDeclaration ||
      parent?.type === AST_NODE_TYPES.ImportExpression) &&
    parent.source === node
  );
}

/**
 * Only provider names an upstream (inner#1743): every model call goes through it, so an upstream's address, name or
 * key variable written anywhere else is a second place that decides where a call goes or how it is read, and it
 * drifts the day provider routes the call elsewhere.
 *
 * The lists come from `config/provider/upstreams.yaml` through the rule's options, so an upstream added there is
 * guarded without touching the rule. A host is reported wherever a string spells it; a name or key variable when a
 * string is exactly it, or when it is a property key or a member name. A use of the same word that does not mean
 * the upstream (Google sign-in, a brand icon) is excused in {@link EXCUSED}, with the reason.
 */
export const noUpstreamLiteral = createRule<[Options], "upstreamHost" | "upstreamName">({
  name: "no-upstream-literal",
  meta: {
    type: "problem",
    docs: {
      description: "Upstream addresses, names and key variables are written only in @breatic/provider",
    },
    schema: [
      {
        type: "object",
        properties: {
          hosts: { type: "array", items: { type: "string" } },
          names: { type: "array", items: { type: "string" } },
        },
        required: ["hosts", "names"],
        additionalProperties: false,
      },
    ],
    messages: {
      upstreamHost:
        "'{{host}}' is an upstream's address. Model calls go through @breatic/provider, which alone knows where they are sent.",
      upstreamName:
        "'{{name}}' names an upstream or its key. Ask @breatic/provider (servedBy, availability, Cost) instead of naming one here.",
    },
  },
  defaultOptions: [{ hosts: [], names: [] }],
  create(context, [{ hosts, names }]) {
    const named = new Set(names);
    const host = hosts.length === 0
      ? undefined
      : new RegExp(`(?<![\\w-])(?:${hosts.map((h) => h.replace(/\./g, "\\.")).join("|")})(?![\\w-])`);

    /**
     * Reports a name.
     * @param node Node to report on.
     * @param name The word.
     */
    function checkName(node: TSESTree.Node, name: string): void {
      if (named.has(name) && !isExcused(context.filename, name)) context.report({ node, messageId: "upstreamName", data: { name } });
    }

    /**
     * Reports a string that spells an upstream's host, or is exactly one of its names.
     * @param node Node to report on.
     * @param text The string.
     */
    function checkText(node: TSESTree.Node, text: string): void {
      if (isModuleSource(node)) return;
      const hit = host?.exec(text);
      if (hit) {
        context.report({ node, messageId: "upstreamHost", data: { host: hit[0] } });
        return;
      }
      checkName(node, text);
    }

    /**
     * Reports a key spelled as an identifier; a quoted key is a string literal and reported as one.
     * @param key The key.
     * @param computed Whether it is computed.
     */
    function checkKey(key: TSESTree.Node, computed: boolean): void {
      if (!computed && key.type === AST_NODE_TYPES.Identifier) checkName(key, key.name);
    }

    const listeners: TSESLint.RuleListener = {
      ...stringLiteralVisitors(checkText),
      MemberExpression: (node: TSESTree.MemberExpression): void => {
        if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) checkName(node.property, node.property.name);
      },
      Property: (node: TSESTree.Property): void => checkKey(node.key, node.computed),
      PropertyDefinition: (node: TSESTree.PropertyDefinition): void => checkKey(node.key, node.computed),
      TSPropertySignature: (node: TSESTree.TSPropertySignature): void => checkKey(node.key, node.computed),
    };
    return listeners;
  },
});
