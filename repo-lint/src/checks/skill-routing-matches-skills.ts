// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
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

    // A skill is a directory under skills/ with a SKILL.md — the same thing
    // the loader looks for, so this cannot disagree with what actually loads.
    const onDisk = new Set(
      context
        .files((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p), "built-in skills")
        .map((p) => p.split("/")[1] ?? ""),
    );

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
          message: `'${name}' is routed here but no skills/${name}/SKILL.md exists. If it was renamed, the real name is now absent from this file — and absent means allowed nowhere, so that skill 403s for every user and never reaches the model.`,
        });
      }
    }
    for (const name of onDisk) {
      if (!listed.has(name)) {
        findings.push({
          file: `skills/${name}/SKILL.md`,
          message: `This skill has no entry in ${ROUTING_FILE}, so it is allowed nowhere: users get 403 and the model is never told it exists. Add it, naming both surfaces and both authorization axes explicitly.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
