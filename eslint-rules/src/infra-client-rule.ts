// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { moduleSourceVisitors } from "#rules/source-visitors";

/** What a caller must provide to ban one infrastructure client module. */
interface InfraClientRuleSpec {
  /** Rule id, e.g. `no-postgres-outside-core`. */
  readonly name: string;
  /** The bare module specifier to ban, e.g. `postgres`. */
  readonly module: string;
  /** What the caller should reach for instead, named in the message. */
  readonly replacement: string;
}

/**
 * Builds one rule banning direct use of an infrastructure client module.
 *
 * Only `@breatic/core` may construct these clients: it is the single place
 * that configures pool lifetime, idle timeout, keepalive and reconnect
 * behaviour, none of which survive being reinvented per call site. Every
 * other package takes the ready-made singleton from core.
 *
 * Every way to reach the module is covered: a plain or type-only import, a
 * re-export, a dynamic import, and `require`. The regex guards these rules
 * replace read only the literal text `from "<module>"` or `require("...")`,
 * so `await import("ioredis")` passed straight through them — measured, not
 * assumed.
 * @param spec Which module to ban and what to point the caller at.
 * @returns A rule module ready to register under `spec.name`.
 */
export function createInfraClientRule(
  spec: InfraClientRuleSpec,
): TSESLint.RuleModule<"noDirectClient", []> {
  return createRule<[], "noDirectClient">({
    name: spec.name,
    meta: {
      type: "problem",
      docs: {
        description: `Only @breatic/core may use the ${spec.module} client directly`,
      },
      schema: [],
      messages: {
        noDirectClient: `Only @breatic/core may use '${spec.module}' directly — ${spec.replacement}. Core owns the connection lifecycle settings this client needs.`,
      },
    },
    defaultOptions: [],
    create(context) {
      return moduleSourceVisitors(
        (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
          if (source.value === spec.module) {
            context.report({ node, messageId: "noDirectClient" });
          }
        },
      );
    },
  });
}
