// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { posix } from "node:path";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { assertAllowlistIsLive } from "#repo-lint/allowlist";

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

/** Project skills, which hold the long procedures the rules point to. */
const SKILLS_DIRECTORY = ".claude/skills/";

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
 * A mention of a rules file in running text, with what follows it.
 *
 * Groups: 1 the `](` of a markdown link, 2 the path, 3 the anchor, 4 a quoted
 * section name. The anchor class stops at `.` so a sentence's full stop is
 * not read as part of it.
 */
const REFERENCE =
  /(\]\(\s*)?((?:\.{1,2}\/|[\w.-]+\/)*(?:AGENTS|SKILL)\.md)(#[\p{L}\p{N}_-]*)?(\s*["\u201C\u300C][^"\u201D\u300D]+["\u201D\u300D])?/gu;

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
 * Whether a path is one of the files agents read as instructions.
 * @param path Repo-relative path.
 * @returns True for rules, pointers and project skills.
 */
function isInstructionFile(path: string): boolean {
  return isRulesFile(path) || isPointerFile(path) || path.startsWith(SKILLS_DIRECTORY);
}

/**
 * The GitHub anchor slugs of every heading in a markdown file.
 *
 * GitHub lower-cases the heading text, drops everything that is not a
 * letter, digit, space, hyphen or underscore, turns spaces into hyphens, and
 * numbers repeats `-1`, `-2` in order. Lines inside fenced code are not
 * headings.
 * @param markdown File contents.
 * @returns The slugs, in document order.
 */
export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!.charAt(0);
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
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
  for (const file of rulesFiles) {
    const pointer = posix.join(posix.dirname(file), POINTER_FILE);
    if (!context.exists(pointer)) {
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
 * @param lines The file's lines.
 * @returns A finding per unresolvable reference.
 */
function checkReferences(context: CheckContext, file: string, lines: readonly string[]): Finding[] {
  if (isInstructionFile(file) || file.startsWith("repo-lint/src/") || /(^|\/)\.(docker|git)ignore$/.test(file)) {
    return [];
  }
  const findings: Finding[] = [];
  lines.forEach((text, index) => {
    for (const match of text.matchAll(REFERENCE)) {
      const [, link, path = "", anchor, quoted] = match;
      // A bare word in prose ("each package's AGENTS.md") is not a reference.
      if (!link && !anchor && !quoted && !path.includes("/")) continue;
      const relative = link !== undefined || path.startsWith("./") || path.startsWith("../");
      const target = relative ? posix.normalize(posix.join(posix.dirname(file), path)) : path;
      let message: string | null = null;
      if (!context.exists(target)) {
        message = `References ${target}, which does not exist.`;
      } else if (!anchor || anchor === "#") {
        message = `References ${target} without a #anchor. Name the heading of the rule it means, e.g. ${target}#<heading>.`;
      } else if (!headingSlugs(context.read(target)).has(anchor.slice(1))) {
        message = `${target} has no heading for ${anchor}. The rule moved or was renamed; point at where it is now.`;
      }
      if (message !== null) findings.push({ file, line: index + 1, message });
    }
  });
  return findings;
}

/**
 * Agent rule files are laid out the way Claude Code loads them, and every
 * reference to a rule still finds it.
 *
 * Rules live in one `AGENTS.md` per directory; the `CLAUDE.md` beside each is
 * the single import line that makes Claude Code read it. Code comments and
 * docs that cite a rule do so by path and heading anchor, which this resolves
 * — a citation by quoted section name or by "see the package's rules" goes
 * stale the moment the rule moves, with nothing to notice.
 */
export const agentRuleFiles = {
  name: "agent-rule-files",
  description: "AGENTS.md rules load through a one-line CLAUDE.md, and references to them resolve",
  run(context: CheckContext): Finding[] {
    const rulesFiles = context.files(isRulesFile, `${RULES_FILE} files`);
    assertAllowlistIsLive(context, POINTER_MENTION_ALLOWED);
    const findings = checkLayout(context, rulesFiles);
    for (const file of context.textFiles(() => true, "tracked text files")) {
      const lines = context.read(file).split("\n");
      findings.push(...checkPointerMentions(file, lines), ...checkReferences(context, file, lines));
    }
    return findings;
  },
} satisfies Check;
