// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { stringLiteralVisitors } from "#rules/source-visitors";
import { createRule } from "#rules/create-rule";

/**
 * The hosts this product is deployed under.
 *
 * Source names neither of them. Which host a build talks to is a
 * deployment decision, so it arrives through configuration — the dev proxy
 * reads a local port, the server reads its public URL from the injected
 * env. A hostname compiled into source is that decision made once, for
 * everybody, in the one place nobody looks.
 */
const DEPLOYED_HOSTS = ["thinkai.cc", "breatic.ai"];

/** Matches any deployed host appearing inside a string. */
const DEPLOYED_HOST = new RegExp(
  DEPLOYED_HOSTS.map((host) => host.replace(/\./g, "\\.")).join("|"),
);

/**
 * A deployed hostname never appears in a string literal.
 *
 * The concrete damage this prevents is the dev proxy: point /api, /uploads
 * or /ws at the deployed host and every developer's `pnpm dev` sends its
 * traffic to shared infrastructure, which makes local changes untestable
 * and is indistinguishable from the app working.
 *
 * The rule is wider than the proxy on purpose. The guard it replaces
 * watched three filenames, and it had already gone blind once exactly that
 * way: it named `vite.config.ts` while the file had become `vite.config.mts`,
 * so for months it read a path that did not exist and reported clean.
 * Judging every string in the package instead of three filenames removes
 * that failure mode rather than re-creating it in a new syntax.
 *
 * Only strings, so the comments explaining this rule are not violations of
 * it. That distinction cost the guard a hand-written quote-class regex,
 * which still matched backticks inside doc comments — the AST simply never
 * sees a comment.
 */
export const noDeployedHost = createRule<[], "deployedHost">({
  name: "no-deployed-host",
  meta: {
    type: "problem",
    docs: {
      description: "Deployed hostnames come from configuration, not source",
    },
    schema: [],
    messages: {
      deployedHost:
        "'{{host}}' is a deployed host. Source reads the target from configuration — a hardcoded host sends local traffic to shared infrastructure.",
    },
  },
  defaultOptions: [],
  create(context) {
    /**
     * Reports the node when its text names a deployed host.
     * @param node Node to report on.
     * @param text The string to test.
     */
    function check(node: TSESTree.Node, text: string): void {
      const hit = DEPLOYED_HOST.exec(text);
      if (hit) {
        context.report({
          node,
          messageId: "deployedHost",
          data: { host: hit[0] },
        });
      }
    }

    return stringLiteralVisitors(check);
  },
});
