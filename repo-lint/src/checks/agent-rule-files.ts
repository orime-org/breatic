// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { posix } from "node:path";
import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { parse as parseYaml } from "yaml";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { assertAllowlistIsLive } from "#repo-lint/allowlist";
import { TEST_FILE } from "#repo-lint/file-kinds";

/** The rules themselves: one per directory that has any. */
const RULES_FILE = "AGENTS.md";

/** A project skill, which rules point into as well. */
const SKILL_FILE = "SKILL.md";

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
const ABSOLUTE_URL = /\b[a-z][a-z\d+.-]*:\/\/\S+/gi;

/** A link target with a scheme (`https:`, `mailto:`) leaves this checkout. */
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** An `href` attribute in raw HTML, which GitHub renders as a link. */
const HREF = /\bhref\s*=\s*(["'])(.*?)\1/gis;

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

/** A markdown file split the way GitHub renders it. */
interface ParsedMarkdown {
  /** The YAML front matter, delimiters included; empty when there is none. */
  frontMatter: string;
  /** The body, parsed with the front matter's lines blanked so line numbers hold. */
  root: MarkdownNode;
}

/**
 * Whether text is a YAML mapping, the only front matter GitHub renders as such.
 * @param text The lines between the delimiters.
 * @returns True for a mapping.
 */
function isYamlMapping(text: string): boolean {
  try {
    const value: unknown = parseYaml(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Parses markdown as GitHub renders it: a leading `---` block is front
 * matter only when it holds a YAML mapping, otherwise it is a thematic break.
 * @param markdown File contents.
 * @returns The front matter and the parsed body.
 */
function parseMarkdown(markdown: string): ParsedMarkdown {
  const lines = markdown.split("\n");
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
    if (end !== -1 && isYamlMapping(lines.slice(1, end).join("\n"))) {
      const frontMatter = lines.slice(0, end + 1).join("\n");
      return {
        frontMatter,
        root: fromMarkdown(frontMatter.replace(/[^\n]/g, "") + markdown.slice(frontMatter.length)),
      };
    }
  }
  return { frontMatter: "", root: fromMarkdown(markdown) };
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
  visit(parseMarkdown(markdown).root);
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
  const scan = text.replace(ABSOLUTE_URL, (url) => " ".repeat(url.length));
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
 * The reference a link target makes, resolved the way GitHub resolves it:
 * against the linking file, or the repository root for a leading `/`.
 * @param file The file holding the link.
 * @param url The link target as written.
 * @param line The line the link is on.
 * @returns The reference, or null when the target is not a rules file or skill.
 */
function linkReference(file: string, url: string, line: number): Reference | null {
  if (HAS_SCHEME.test(url)) return null;
  const hash = url.indexOf("#");
  const path = decode((hash === -1 ? url : url.slice(0, hash)).replace(/\?.*$/, ""));
  const name = posix.basename(path);
  if (name !== RULES_FILE && name !== SKILL_FILE) return null;
  return {
    line,
    target: path.startsWith("/") ? path.slice(1) : posix.normalize(posix.join(posix.dirname(file), path)),
    anchor: hash === -1 ? "" : decode(url.slice(hash + 1)),
  };
}

/**
 * References in raw HTML: each `href` as a link target, the rest as prose.
 * @param file The file holding the HTML.
 * @param html The HTML as written.
 * @param firstLine The line the HTML starts on.
 * @returns The references found.
 */
function htmlReferences(file: string, html: string, firstLine: number): Reference[] {
  const references: Reference[] = [];
  for (const match of html.matchAll(HREF)) {
    const line = firstLine + (html.slice(0, match.index).match(/\n/g)?.length ?? 0);
    const reference = linkReference(file, match[2] ?? "", line);
    if (reference) references.push(reference);
  }
  const rest = html.replace(HREF, (attribute) => attribute.replace(/[^\n]/g, " "));
  return [...references, ...textReferences(file, rest, firstLine)];
}

/**
 * References in a markdown file: link, definition and `href` targets, and
 * path references in prose, inline code and front matter. Fenced code holds
 * samples, not citations.
 * @param file The markdown file.
 * @param markdown Its contents.
 * @returns The references found.
 */
function markdownReferences(file: string, markdown: string): Reference[] {
  const { frontMatter, root } = parseMarkdown(markdown);
  const references = textReferences(file, frontMatter, 1);
  /**
   * Collects the references under a node, not descending into links.
   * @param node The node to walk.
   */
  const visit = (node: MarkdownNode): void => {
    const line = node.position?.start.line ?? 1;
    if ((node.type === "link" || node.type === "definition") && node.url !== undefined) {
      const reference = linkReference(file, node.url, line);
      if (reference) references.push(reference);
      return;
    }
    if (node.type === "text" || node.type === "inlineCode") {
      references.push(...textReferences(file, node.value ?? "", line));
      return;
    }
    if (node.type === "html") {
      references.push(...htmlReferences(file, node.value ?? "", line));
      return;
    }
    node.children?.forEach(visit);
  };
  visit(root);
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
