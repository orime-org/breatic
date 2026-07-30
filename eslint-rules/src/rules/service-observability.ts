// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The long-running services, each with one entry point. */
const SERVICE_ENTRY = /packages\/(server|worker|collab)\/src\/index\.ts$/;

/**
 * The three idiomatic ways a logger is obtained here.
 *
 * Not stylistic alternatives — each service does it differently: collab
 * builds a named child, worker initialises the shared one, and server calls
 * a level on the default.
 */
const LOGGER_FACTORY = new Set(["createLogger", "initLogger"]);

/** Levels whose presence proves a logger is in hand and being used. */
const LOGGER_LEVEL = new Set(["info", "warn", "error", "debug", "fatal", "trace"]);

/** The call that puts /healthz on the air. */
const HEALTH_SERVER = "startHealthServer";

/**
 * Long-running services wire a logger and a health endpoint.
 *
 * A service whose logger is never wired fails quietly, which is the worst
 * way to fail: collab ran for a fortnight with dead file logging and the
 * only symptom anybody saw was a stuck "session invalid" banner, turning a
 * recoverable connection fault into an undiagnosable one. A missing
 * /healthz is the same shape of problem — a drifted connection keeps
 * reading as healthy, so nothing replaces the instance.
 *
 * This asserts the wiring exists in source, not that anything is emitted at
 * runtime; that is what smoke tests cover. Stopping a wire from being
 * deleted unnoticed is the whole job, and it is a real and cheap regression
 * class to catch.
 *
 * Requires a CALL, where the guard it replaces matched text. Measured on
 * that guard: a file containing only `import { startHealthServer } from
 * "@breatic/core";` satisfied it — an import is not a wire, and a refactor
 * that removed the call while leaving the import tidy would have passed.
 *
 * The other half of this invariant cannot live in a rule. If an entry file
 * is deleted or renamed, no file gets linted and a rule has nothing to say;
 * that the three entries exist is asserted by the repo-wide checks.
 */
export const serviceObservability = createRule<
  [],
  "noLogger" | "noHealthServer"
>({
  name: "service-observability",
  meta: {
    type: "problem",
    docs: {
      description: "Service entries wire a logger and a health server",
    },
    schema: [],
    messages: {
      noLogger:
        "This service entry never calls a logger. A service whose logging is not wired fails silently — collab ran a fortnight that way and the only symptom was an undiagnosable banner. Call createLogger, initLogger, or a level on the shared logger.",
      noHealthServer: `This service entry never calls ${HEALTH_SERVER}(). Without /healthz a drifted connection keeps reading as healthy, so nothing replaces the instance.`,
    },
  },
  defaultOptions: [],
  create(context) {
    if (!SERVICE_ENTRY.test(context.filename.replace(/\\/g, "/"))) return {};

    let hasLogger = false;
    let hasHealthServer = false;

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        const callee = node.callee;
        if (callee.type === AST_NODE_TYPES.Identifier) {
          if (LOGGER_FACTORY.has(callee.name)) hasLogger = true;
          if (callee.name === HEALTH_SERVER) hasHealthServer = true;
          return;
        }
        if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          callee.property.type === AST_NODE_TYPES.Identifier
        ) {
          if (callee.property.name === HEALTH_SERVER) hasHealthServer = true;
          if (
            LOGGER_LEVEL.has(callee.property.name) &&
            calleeMentionsLogger(callee.object)
          ) {
            hasLogger = true;
          }
        }
      },

      "Program:exit"(node: TSESTree.Program): void {
        if (!hasLogger) context.report({ node, messageId: "noLogger" });
        if (!hasHealthServer) {
          context.report({ node, messageId: "noHealthServer" });
        }
      },
    };
  },
});

/**
 * Whether the object a level was called on is a logger.
 *
 * Accepts `logger.info(...)` and `something.logger.info(...)`, which is how
 * a scoped or child logger reads, and rejects `console.info(...)` — the
 * library boundary forbids that, and counting it here would let a service
 * satisfy the rule with the very thing another rule bans.
 * @param object The member expression's object.
 * @returns True when it names a logger.
 */
function calleeMentionsLogger(object: TSESTree.Node): boolean {
  if (object.type === AST_NODE_TYPES.Identifier) {
    return /logger$/i.test(object.name);
  }
  if (
    object.type === AST_NODE_TYPES.MemberExpression &&
    object.property.type === AST_NODE_TYPES.Identifier
  ) {
    return /logger$/i.test(object.property.name);
  }
  return false;
}
