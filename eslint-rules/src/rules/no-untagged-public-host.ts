// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { stringLiteralVisitors } from "#rules/source-visitors";

/** The tag that declares a case reaches the public internet. */
const INTERNET_TAG = "@needs-internet";

/** Matches the host in an http or https url. */
const URL_HOST = /\bhttps?:\/\/([^/\s"'`$]+)/g;

/**
 * Urls that name something rather than address it.
 *
 * XML namespaces are identifiers: the Namespaces in XML spec says the name
 * "is not, per se, dereferenced", and an `xmlns` attribute is compared as a
 * string. The bytes of an SVG carry one, and nothing fetches it.
 */
const NAMESPACES = [
  "http://www.w3.org/",
  "https://www.w3.org/",
  "http://purl.org/",
  "https://purl.org/",
];

/**
 * Host names that resolve to the machine the run is on.
 *
 * A port may follow, so these are compared against the host with any port
 * stripped.
 */
const OUR_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Suffixes RFC 2606 and RFC 6761 reserve, which never resolve.
 *
 * `.example` and `example.com` are the ones this suite uses for inputs that
 * only have to look like a url, plus `.test`, `.invalid` and `.localhost`
 * for completeness.
 */
const RESERVED = [
  ".example",
  ".test",
  ".invalid",
  ".localhost",
  "example.com",
  "example.net",
  "example.org",
];

/**
 * Answers whether a host needs the public internet to answer.
 *
 * The port is dropped, and a bare trailing colon with it: a template
 * literal puts its port in an interpolation, so the chunk the AST hands
 * over ends at `localhost:`.
 * @param host The host as written, possibly with a port.
 * @returns Whether reaching it leaves this machine.
 */
function isPublic(host: string): boolean {
  const name = host.replace(/:\d*$/, "").toLowerCase();
  if (OUR_MACHINE.has(name)) return false;
  return !RESERVED.some(
    (suffix) => name === suffix.replace(/^\./, "") || name.endsWith(suffix),
  );
}

/**
 * A public host appears only where the case says it reaches one.
 *
 * Playwright's own guidance is *Only test what you control. Don't try to
 * test links to external sites or third party servers that you do not
 * control* — a case pointed at somebody else's server goes red when that
 * server has a bad day, and the report blames this product.
 *
 * Reaching one is still allowed, because some cases genuinely check that we
 * can fetch a url a reader pasted. What they carry is the tag: it keeps
 * them out of the run on a machine with no way out to the internet, so the
 * green that machine reports covers what it could actually reach.
 *
 * Which is why the judgement is the pair and not the address alone. A rule
 * that banned every public host would contradict the tag it is meant to
 * enforce, and the cases that legitimately reach one would have nowhere to
 * live.
 *
 * The tag is read off the case the url sits in, because that is the
 * granularity the exclusion works at: `--grep-invert` matches titles, one
 * case at a time, so a file holding one tagged case still runs its other
 * cases on a machine with no way out. A url at module scope belongs to
 * whatever reads it, which the AST cannot say, so there the file answers.
 */
export const noUntaggedPublicHost = createRule<[], "untaggedHost">({
  name: "no-untagged-public-host",
  meta: {
    type: "problem",
    docs: {
      description: "A case reaching a public host says so with a tag",
    },
    schema: [],
    messages: {
      untaggedHost:
        "'{{host}}' is somebody else's server, so this case goes red when that server does. Tag the case '@needs-internet' so a machine with no way out leaves it alone, or use a fixture this run controls.",
    },
  },
  defaultOptions: [],
  create(context) {
    const fileDeclares = context.sourceCode.getText().includes(INTERNET_TAG);

    /**
     * The title of the case a node sits in, or null at module scope.
     * @param node Node to trace upwards from.
     * @returns The title as written, or null.
     */
    function titleOfEnclosingCase(node: TSESTree.Node): string | null {
      for (let here = node.parent; here; here = here.parent) {
        if (here.type !== AST_NODE_TYPES.CallExpression) continue;
        const callee = here.callee;
        const isTest =
          (callee.type === AST_NODE_TYPES.Identifier &&
            callee.name === "test") ||
          (callee.type === AST_NODE_TYPES.MemberExpression &&
            callee.object.type === AST_NODE_TYPES.Identifier &&
            callee.object.name === "test");
        if (!isTest) continue;
        const title = here.arguments[0];
        if (title?.type === AST_NODE_TYPES.Literal) {
          return typeof title.value === "string" ? title.value : null;
        }
        if (title?.type === AST_NODE_TYPES.TemplateLiteral) {
          return context.sourceCode.getText(title);
        }
        return null;
      }
      return null;
    }

    /**
     * Reports every public host the case around it has not declared.
     *
     * The exclusion runs on titles, one case at a time, so the judgement is
     * the case's own title. A url at module scope belongs to whatever reads
     * it, which the AST cannot say, so there the file answers.
     * @param node Node to report on.
     * @param text The string to search.
     */
    function check(node: TSESTree.Node, text: string): void {
      const title = titleOfEnclosingCase(node);
      const declared =
        title === null ? fileDeclares : title.includes(INTERNET_TAG);
      if (declared) return;
      for (const found of text.matchAll(URL_HOST)) {
        const host = found[1];
        if (!host || !isPublic(host)) continue;
        if (NAMESPACES.some((n) => text.startsWith(n, found.index))) continue;
        context.report({ node, messageId: "untaggedHost", data: { host } });
      }
    }

    return stringLiteralVisitors(check);
  },
});
