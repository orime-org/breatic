// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { isLoggerLevelAccess } from "#rules/logger-shape";

/** The long-running services, each with one entry point. */
const SERVICE_ENTRY = /packages\/(server|worker|collab)\/src\/index\.ts$/;

/**
 * The two ways a logger is constructed here.
 *
 * Not stylistic alternatives: collab builds a named child and worker
 * initialises the shared one. The third idiom — server calling a level on
 * the default logger — is a call on an existing one rather than a
 * construction, so it is recognised through `isLoggerLevelAccess`, imported
 * above from the shared logger shape.
 */
const LOGGER_FACTORY = new Set(["createLogger", "initLogger"]);

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
 *
 * Eager config loading used to be a third branch here and now has its own
 * rule, `eager-config-load`. It did not belong: loading a config file at boot
 * is not observability, and matching one hard-coded loader name left the
 * structurally identical loads beside it unguarded.
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
          if (isLoggerLevelAccess(callee)) hasLogger = true;
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
