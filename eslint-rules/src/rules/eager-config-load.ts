// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The long-running services, each with one entry point. */
const SERVICE_ENTRY = /packages\/(server|worker|collab)\/src\/index\.ts$/;

/**
 * The config loaders that read and validate their file on first use.
 *
 * Every one of them memoizes: the first call reads the yaml, runs it through
 * a zod schema, freezes the result, and every later call returns that. So the
 * cost of loading eagerly is one file read at boot, and the cost of not doing
 * it is that a malformed file stays invisible until the first request that
 * happens to need that config — surfacing there as a 500 on somebody's
 * request rather than as a service that refused to start.
 *
 * This list names loaders, not services. Which of them a given entry has to
 * warm up is answered by that entry's own imports rather than by a table
 * here, which is why adding a service needs no change to this rule.
 */
const LAZY_CONFIG_LOADERS = new Set([
  "getMembershipConfig",
  "getStorageConfig",
  "getSkillRouting",
  "getWorkerConfig",
  "getAgentConfig",
]);

/**
 * Whether a node sits directly in the module body rather than inside
 * something that has to be called first.
 *
 * Module top level is the whole point: a call there runs when the module is
 * imported, which is what "at boot" means. The same call inside a function
 * runs when that function runs, and whether anything ever calls it is not a
 * question this or any other single-file rule can answer.
 *
 * A `try` block around the call is still top level, and is in fact the shape
 * all three entries use — the library throws, the entry logs and exits.
 * @param node - The call to locate
 * @returns True when no function or class encloses it
 */
function isAtModuleTopLevel(node: TSESTree.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    switch (cur.type) {
      case AST_NODE_TYPES.FunctionDeclaration:
      case AST_NODE_TYPES.FunctionExpression:
      case AST_NODE_TYPES.ArrowFunctionExpression:
      case AST_NODE_TYPES.ClassDeclaration:
      case AST_NODE_TYPES.ClassExpression:
        return false;
      case AST_NODE_TYPES.Program:
        return true;
      default:
        break;
    }
  }
  return false;
}

/**
 * A service entry that imports a lazy config loader must call it at startup.
 *
 * The calls this protects look pointless — a function invoked for no return
 * value, the result thrown away — so the failure mode is somebody reading one
 * as dead code and deleting it. Nothing breaks when they do: the tests stay
 * green, the service starts, every feature works. The cost arrives later,
 * when a config file is edited wrongly and the service happily starts anyway.
 *
 * **Why the premise is the import.** The alternative is a table saying which
 * service must warm up which config, which is a second list to keep in step
 * with reality. An import statement already answers the question, sits in the
 * same file as the call, and is visible to a rule that sees one file at a
 * time. An entry that stops needing a config drops the import and the
 * requirement goes with it.
 *
 * **Why top level specifically.** A call in the module body runs on import,
 * which is exactly "at boot". Accepting one inside a function would mean
 * accepting a call nothing ever reaches, and following that would take a call
 * graph this rule does not have.
 *
 * Split out of `service-observability`, which had grown a branch for one
 * hard-coded loader name. Two things were wrong with living there: config
 * loading is not observability, so the rule's name and its stated rationale
 * both described something else; and matching a single name left the two
 * structurally identical loads beside it in the same file unguarded — either
 * of those could be deleted with CI staying green.
 */
export const eagerConfigLoad = createRule<[], "notLoadedEagerly">({
  name: "eager-config-load",
  meta: {
    type: "problem",
    docs: {
      description:
        "A service entry that imports a lazy config loader must call it at module top level",
    },
    schema: [],
    messages: {
      notLoadedEagerly:
        "This service entry imports {{name}} but never calls it at module top level. The loader reads and validates its file on first use, so without an eager call a malformed config stays invisible until the first request that needs it, and surfaces there as a 500 rather than as a service that refused to start. Call {{name}}() at top level, in a try/catch that logs and exits — the shape the other loads in this file already use.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!SERVICE_ENTRY.test(context.filename.replace(/\\/g, "/"))) return {};

    /** Local name → the import specifier, for loaders this entry brings in. */
    const imported = new Map<string, TSESTree.ImportClause>();
    /** Local names called at module top level. */
    const warmed = new Set<string>();

    return {
      ImportSpecifier(node: TSESTree.ImportSpecifier): void {
        // Keyed on the ORIGINAL export name, so `import { getX as y }` is
        // recognised, and tracked under the LOCAL name, which is what a call
        // in this file would use.
        const original =
          node.imported.type === AST_NODE_TYPES.Identifier
            ? node.imported.name
            : null;
        if (original && LAZY_CONFIG_LOADERS.has(original)) {
          imported.set(node.local.name, node);
        }
      },

      CallExpression(node: TSESTree.CallExpression): void {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          isAtModuleTopLevel(node)
        ) {
          warmed.add(node.callee.name);
        }
      },

      "Program:exit"(): void {
        for (const [name, node] of imported) {
          if (!warmed.has(name)) {
            context.report({
              node,
              messageId: "notLoadedEagerly",
              data: { name },
            });
          }
        }
      },
    };
  },
});
