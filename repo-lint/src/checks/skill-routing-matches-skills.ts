// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

const ROUTING_FILE = "config/skill-routing.yaml";

/**
 * The routing file names exactly the skills that exist, in both directions.
 *
 * Since permissions moved out of skill metadata, this file is the only thing
 * that says where a skill may be used and who may fire it. Its schema cannot
 * catch a wrong name: the entries are a `z.record`, so any key parses, and
 * the startup fail-fast that reads this file exits on a malformed value and
 * waves a misspelled key straight through.
 *
 * Both directions fail silently in the same way, which is why both are
 * checked:
 *
 * A key with no skill behind it (typo, or a skill that was renamed or
 * deleted) leaves that skill's real name absent from the file — and absent
 * means allowed nowhere. Every user gets 403 and the model never sees it in
 * its skill list. Nothing logs, because from the gate's point of view an
 * unlisted skill is a correctly denied one.
 *
 * A skill with no key is the same outcome reached the other way: a skill
 * added to `skills/` and not to this file is invisible and unusable, and its
 * author's first evidence is a 403 with no explanation.
 *
 * This is a repo-lint check rather than a unit test because it compares two
 * files neither of which the other imports — a directory listing against a
 * YAML document.
 */
/**
 * Read a skill's declared name out of its SKILL.md frontmatter.
 * @param source - The file's full text.
 * @returns The declared name, or null when the file declares none.
 * @throws {never}
 */
function frontmatterName(source: string): string | null {
  const end = source.indexOf("\n---", 4);
  if (!source.startsWith("---") || end === -1) return null;
  const match = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(source.slice(0, end));
  return match?.[1] ?? null;
}

export const skillRoutingMatchesSkills = {
  name: "skill-routing-matches-skills",
  description: "config/skill-routing.yaml names exactly the skills on disk",
  run(context: CheckContext): Finding[] {
    if (!context.exists(ROUTING_FILE)) {
      return [
        {
          file: ROUTING_FILE,
          message:
            "The skill routing config is gone. Without it every skill is allowed nowhere, and both entry points answer 403 for all of them.",
        },
      ];
    }

    // A skill's name is what its SKILL.md frontmatter declares, NOT its
    // directory. The loader finds the file by walking directories but keys
    // the registry on `frontmatter.name`, and so does every gate that later
    // looks a skill up. Comparing directories would pass a skill whose two
    // names differ while it is denied everywhere — the exact failure this
    // check exists to catch. The repo has carried that shape before: one of
    // the skills this PR deleted lived in a directory named nothing like the
    // name it declared.
    const onDisk = new Set<string>();
    for (const file of context.files(
      (p) => /^skills\/[^/]+\/SKILL\.md$/.test(p),
      "built-in skills",
    )) {
      const declared = frontmatterName(context.read(file));
      // No name at all means the loader skips the file entirely, so there is
      // nothing for the routing config to name either.
      if (declared) onDisk.add(declared);
    }

    // Top-level entries under `skills:`, which the file's shape puts at
    // exactly two spaces of indentation.
    const listed = new Set<string>();
    const lines = context.read(ROUTING_FILE).split("\n");
    let inSkills = false;
    for (const line of lines) {
      if (/^skills:\s*$/.test(line)) {
        inSkills = true;
        continue;
      }
      if (!inSkills) continue;
      if (/^\S/.test(line)) break;
      const entry = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
      if (entry?.[1]) listed.add(entry[1]);
    }

    if (listed.size === 0) {
      return [
        {
          file: ROUTING_FILE,
          message:
            "No skill entries were found in this file. Either it lists none — in which case every skill is denied everywhere — or its shape changed and this check is now reading nothing, which would report clean forever.",
        },
      ];
    }

    const findings: Finding[] = [];
    for (const name of listed) {
      if (!onDisk.has(name)) {
        findings.push({
          file: ROUTING_FILE,
          message: `'${name}' is routed here but no skill declares that name. Names come from each SKILL.md's frontmatter, not from its directory. If one was renamed, the real name is now absent from this file — and absent means allowed nowhere, so that skill 403s for every user and never reaches the model.`,
        });
      }
    }
    for (const name of onDisk) {
      if (!listed.has(name)) {
        findings.push({
          file: `the skill declaring name '${name}'`,
          message: `This skill has no entry in ${ROUTING_FILE}, so it is allowed nowhere: users get 403 and the model is never told it exists. Add it, naming both surfaces and both authorization axes explicitly.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
