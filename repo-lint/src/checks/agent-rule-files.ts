// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { posix } from "node:path";
import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { assertAllowlistIsLive } from "#repo-lint/allowlist";
import { TEST_FILE } from "#repo-lint/file-kinds";

/** The rules themselves: one per directory that has any. */
const RULES_FILE = "AGENTS.md";

/**
 * The file Claude Code actually reads. It only imports the rules beside it,
 * so a rule written here is a second copy that drifts.
 */
const POINTER_FILE = "CLAUDE.md";

/** The whole of a pointer file. */
const POINTER_CONTENT = "@AGENTS.md\n";

/** Claude Code's guidance for a memory file; past it adherence drops. */
const MAX_RULE_LINES = 200;

/** The skill that explains how rule files work, and so has to name them. */
const EDITING_SKILL = ".claude/skills/editing-agent-rules/";

/** This check's own source and tests, which name both files by necessity. */
const THIS_CHECK = /^repo-lint\/src\/checks\/(__tests__\/)?agent-rule-files(\.test)?\.ts$/;

/**
 * Single files allowed to name the pointer file, each with its reason.
 *
 * Kept to exact paths so `assertAllowlistIsLive` can prove each still
 * exists; exemptions by purpose are the predicates below instead.
 */
const POINTER_MENTION_ALLOWED: ReadonlyMap<string, string> = new Map([
  [".dockerignore", "keeps the rule files out of the image build context"],
]);

/**
 * A path to a rules file written as text, with its anchor.
 *
 * Groups: 1 the path, 2 the anchor. The path must not continue a longer
 * token, so a placeholder such as `packages/<pkg>/AGENTS.md` is not read as
 * a path. The anchor class stops at `.` so a sentence's full stop is not
 * read as part of it.
 */
const PATH_REFERENCE = /(?<![\w./-])((?:\.{1,2}\/|[\w.-]+\/)*(?:AGENTS|SKILL)\.md)(#[\p{L}\p{N}\p{M}_%-]*)?/gu;

/** Absolute URLs point outside this checkout. */
const URL = /\b[a-z][a-z\d+.-]*:\/\/\S+/gi;

/** A link target with a scheme (`https:`, `mailto:`) leaves this checkout. */
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** The slice of an mdast node this check reads. */
interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { line: number } };
}

/** One place a file points into a rules file or skill. */
interface Reference {
  line: number;
  /** Repo-relative target path. */
  target: string;
  /** Without the `#`; empty when the reference has none. */
  anchor: string;
}

/**
 * Parses markdown as GitHub renders it, with YAML front matter (which GitHub
 * shows as a table) blanked so its lines keep their numbers.
 * @param markdown File contents.
 * @returns The mdast root.
 */
function parseMarkdown(markdown: string): MarkdownNode {
  const frontMatter = /^---\n[\s\S]*?\n---(?=\n|$)/.exec(markdown);
  const body = frontMatter ? markdown.replace(frontMatter[0], frontMatter[0].replace(/[^\n]/g, "")) : markdown;
  return fromMarkdown(body);
}

/**
 * Decodes a percent-encoded link part, keeping it as written when it is not
 * valid encoding.
 * @param text The path or anchor as written.
 * @returns The decoded text.
 */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The GitHub anchor slugs of every heading in a markdown file.
 *
 * Headings are found by a CommonMark parser and slugged from their visible
 * text with `github-slugger`, which numbers repeats the way GitHub does.
 * @param markdown File contents.
 * @returns The slugs, in document order.
 */
export function headingSlugs(markdown: string): Set<string> {
  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  /**
   * Collects the slug of each heading under a node.
   * @param node The node to walk.
   */
  const visit = (node: MarkdownNode): void => {
    if (node.type === "heading") {
      slugs.add(slugger.slug(toString(node, { includeHtml: false })));
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parseMarkdown(markdown));
  return slugs;
}

/**
 * Path references written as text: a path containing `/`, or any path with
 * an anchor. A bare file name in prose names the kind of file, not a rule.
 * @param file The file the text is in.
 * @param text The text to scan.
 * @param firstLine The line number of the text's first line.
 * @returns The references found.
 */
function textReferences(file: string, text: string, firstLine: number): Reference[] {
  const references: Reference[] = [];
  const scan = text.replace(URL, (url) => " ".repeat(url.length));
  for (const match of scan.matchAll(PATH_REFERENCE)) {
    const [, path = "", anchor = ""] = match;
    if (!anchor && !path.includes("/")) continue;
    const relative = path.startsWith("./") || path.startsWith("../");
    references.push({
      line: firstLine + (scan.slice(0, match.index).match(/\n/g)?.length ?? 0),
      target: relative ? posix.normalize(posix.join(posix.dirname(file), path)) : path,
      anchor: decode(anchor.slice(1)),
    });
  }
  return references;
}

/**
 * References in a markdown file: link and definition targets, resolved the
 * way GitHub resolves them, and path references in prose and inline code.
 * Fenced code holds samples, not citations.
 * @param file The markdown file.
 * @param markdown Its contents.
 * @returns The references found.
 */
function markdownReferences(file: string, markdown: string): Reference[] {
  const references: Reference[] = [];
  /**
   * Collects the references under a node, not descending into links.
   * @param node The node to walk.
   */
  const visit = (node: MarkdownNode): void => {
    const line = node.position?.start.line ?? 1;
    if ((node.type === "link" || node.type === "definition") && node.url !== undefined) {
      const hash = node.url.indexOf("#");
      const path = decode(hash === -1 ? node.url : node.url.slice(0, hash));
      const name = posix.basename(path);
      if (!HAS_SCHEME.test(node.url) && (name === RULES_FILE || name === "SKILL.md")) {
        references.push({
          line,
          target: path.startsWith("/") ? path.slice(1) : posix.normalize(posix.join(posix.dirname(file), path)),
          anchor: hash === -1 ? "" : decode(node.url.slice(hash + 1)),
        });
      }
      return;
    }
    if (node.type === "text" || node.type === "inlineCode") {
      references.push(...textReferences(file, node.value ?? "", line));
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parseMarkdown(markdown));
  return references;
}

/**
 * Whether a path is a rules file.
 * @param path Repo-relative path.
 * @returns True for any `AGENTS.md`.
 */
function isRulesFile(path: string): boolean {
  return posix.basename(path) === RULES_FILE;
}

/**
 * Whether a path is a pointer file.
 * @param path Repo-relative path.
 * @returns True for any `CLAUDE.md`.
 */
function isPointerFile(path: string): boolean {
  return posix.basename(path) === POINTER_FILE;
}

/**
 * Rules 1–3: each pointer imports only its rules, each rules file has a
 * pointer, and no rules file outgrows what a model reliably follows.
 * @param context The check context.
 * @param rulesFiles Every `AGENTS.md`.
 * @returns Findings for these three rules.
 */
function checkLayout(context: CheckContext, rulesFiles: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const pointers = context.files(isPointerFile, `${POINTER_FILE} files`);
  for (const file of pointers) {
    if (context.read(file) === POINTER_CONTENT) continue;
    findings.push({
      file,
      line: 1,
      message: `${POINTER_FILE} must hold only the line \`@AGENTS.md\`. Write the rule into the ${RULES_FILE} beside it.`,
    });
  }
  const pointerSet = new Set(pointers);
  for (const file of rulesFiles) {
    const pointer = posix.join(posix.dirname(file), POINTER_FILE);
    if (!pointerSet.has(pointer)) {
      findings.push({
        file,
        message: `No ${POINTER_FILE} beside this file, so Claude Code never loads it: it is not loaded until ${pointer} exists holding \`@AGENTS.md\`.`,
      });
    }
    const lines = context.read(file).replace(/\n$/, "").split("\n").length;
    if (lines > MAX_RULE_LINES) {
      findings.push({
        file,
        line: MAX_RULE_LINES + 1,
        message: `${lines} lines, over the ${MAX_RULE_LINES}-line limit. Move what is only needed for one kind of work into a project skill.`,
      });
    }
  }
  return findings;
}

/**
 * Rule 4: nothing points at the pointer file, because no rule lives there.
 * @param file Repo-relative path.
 * @param lines The file's lines.
 * @returns A finding per line that names the pointer file.
 */
function checkPointerMentions(file: string, lines: readonly string[]): Finding[] {
  if (
    isRulesFile(file) ||
    isPointerFile(file) ||
    file.startsWith(EDITING_SKILL) ||
    THIS_CHECK.test(file) ||
    POINTER_MENTION_ALLOWED.has(file)
  ) {
    return [];
  }
  const findings: Finding[] = [];
  lines.forEach((text, index) => {
    if (!text.includes(POINTER_FILE)) return;
    findings.push({
      file,
      line: index + 1,
      message: `Names ${POINTER_FILE}, which only imports ${RULES_FILE}. Point at the rule in ${RULES_FILE} with a path and #anchor.`,
    });
  });
  return findings;
}

/**
 * Rule 5: every reference into a rules file or skill names a heading that is
 * there, so moving or deleting a rule breaks the build instead of the link.
 * @param context The check context.
 * @param file Repo-relative path.
 * @returns A finding per unresolvable reference.
 */
function checkReferences(context: CheckContext, file: string): Finding[] {
  if (
    isRulesFile(file) ||
    isPointerFile(file) ||
    file.startsWith(EDITING_SKILL) ||
    (file.startsWith("repo-lint/") && TEST_FILE.test(file)) ||
    THIS_CHECK.test(file) ||
    /(^|\/)\.(docker|git)ignore$/.test(file)
  ) {
    return [];
  }
  const text = context.read(file);
  const references = file.endsWith(".md") ? markdownReferences(file, text) : textReferences(file, text, 1);
  const findings: Finding[] = [];
  for (const { line, target, anchor } of references) {
    let message: string | null = null;
    if (!context.exists(target)) {
      message = `References ${target}, which does not exist.`;
    } else if (!anchor) {
      message = `References ${target} without a #anchor. Name the heading of the rule it means, e.g. ${target}#<heading>.`;
    } else if (!headingSlugs(context.read(target)).has(anchor)) {
      message = `${target} has no heading for #${anchor}. The rule moved or was renamed; point at where it is now.`;
    }
    if (message !== null) findings.push({ file, line, message });
  }
  return findings;
}

/**
 * Agent rule files are laid out the way Claude Code loads them, and every
 * reference to a rule still finds it.
 *
 * Rules live in one `AGENTS.md` per directory; the `CLAUDE.md` beside each is
 * the single import line that makes Claude Code read it. Code comments and
 * docs that cite a rule do so by path and heading anchor, which this resolves
 * the way GitHub does, so a rule that moves breaks the build instead of the
 * citation.
 */
export const agentRuleFiles = {
  name: "agent-rule-files",
  description: "AGENTS.md rules load through a one-line CLAUDE.md, and references to them resolve",
  run(context: CheckContext): Finding[] {
    const rulesFiles = context.files(isRulesFile, `${RULES_FILE} files`);
    assertAllowlistIsLive(context, POINTER_MENTION_ALLOWED);
    const findings = checkLayout(context, rulesFiles);
    for (const file of context.textFiles(() => true, "tracked text files")) {
      findings.push(...checkPointerMentions(file, context.read(file).split("\n")), ...checkReferences(context, file));
    }
    return findings;
  },
} satisfies Check;
