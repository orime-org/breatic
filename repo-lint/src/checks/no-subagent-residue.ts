// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every name a deletion removed, paired with what it was and the change that
 * removed it.
 *
 * Assembled rather than written out, so this file is not the first thing its
 * own check reports and needs no exemption for itself. An exemption is a
 * thing to maintain and a place a real residue could hide — the same reason
 * `no-auth-bypass-residue` assembles its list.
 *
 * The list is the single source of truth: the scan is derived from it, never
 * written alongside it, so the two cannot disagree.
 *
 * Exported so the tests plant every entry rather than a sample. A test naming
 * a handful of them reads as covering the list, and the next name added would
 * arrive with nothing exercising it.
 *
 * Each name is matched as a substring, so a name that is a substring of a
 * living symbol cannot go in. Two were rejected on exactly that ground and
 * the reasons are worth keeping, because both look safe until measured:
 *
 * - `getAgent` is a prefix of `getAgentConfig`, the config reader, which is
 *   alive and widely used and has nothing to do with the deleted concept.
 *   The loader's module path stands in for it — that path appears in every
 *   file importing the symbol.
 * - bare `spawn` is what worker calls to start ffmpeg child processes, in
 *   many files. The dispatch tool and the billing counter are named in full
 *   below, which is precise.
 *
 * How many files each of those would have hit is deliberately not written
 * here. Both counts were measured once and both were wrong within the same
 * change that recorded them — the deletion this guard exists for is what
 * moved them. What makes the two exclusions right is that the names collide
 * with living symbols at all, which stays true however many there are.
 */
export const DELETED_NAMES: ReadonlyArray<readonly [string, string, string]> = [
  // The dispatch machinery.
  [["spawn", "Tool"].join(""), "the dispatch tool that ran a derived agent", "PR-2"],
  [["spawn", "Count"].join(""), "the per-turn counter that numbered those runs", "PR-2"],
  [["agent", "loader"].join("-"), "the module that read the agent definitions", "PR-2"],
  [["load", "Agents"].join(""), "the agent-definition loader", "PR-2"],
  [["list", "Agents"].join(""), "the agent-definition lister", "PR-2"],
  [["sub", "agent"].join("-"), "the deleted concept, hyphenated", "PR-2"],
  [["Sub", "Agent"].join(""), "the deleted concept, in a symbol", "PR-2"],
  // The five filesystem and script tools, and what supported them.
  [["run", "script"].join("_"), "the script-execution tool", "PR-2"],
  [["read", "file"].join("_"), "the file-read tool", "PR-2"],
  [["write", "file"].join("_"), "the file-write tool", "PR-2"],
  [["edit", "file"].join("_"), "the file-edit tool", "PR-2"],
  [["list", "dir"].join("_"), "the directory-listing tool", "PR-2"],
  [["fs", "sandbox"].join("-"), "the sandbox the file tools ran inside", "PR-2"],
  [
    ["FILE", "TOOL", "SANDBOX", "DIR"].join("_"),
    "the env var that configured that sandbox",
    "PR-2",
  ],
  [["DEFAULT", "TOOLS"].join("_"), "the tool-set constant with no consumers", "PR-2"],
  // The two deleted skills.
  [["skill", "creator"].join("_"), "the skill that let users author skills", "PR-2"],
  [["a", "fame"].join(""), "the skill whose script the deleted tool ran", "PR-2"],
  // The superseded plan-JSON path.
  [["extract", "Plan"].join(""), "the function that scraped plan JSON from text", "PR-2"],
  [["chat", "plan"].join("_"), "the SSE event that carried that JSON", "PR-2"],
  [["task", "plan"].join("_"), "the skill output type that produced it", "PR-2"],
  // The skill mechanism, replaced by generation templates.
  [["skills", "loader"].join("-"), "the module that read the skills directory", "inner#977"],
  [["get", "Skill", "Registry"].join(""), "the skill registry", "inner#977"],
  [["skill", "routing"].join("-"), "the config of where a skill could run", "inner#977"],
  [["assert", "Skill", "Usable"].join(""), "the gate a skill passed before it ran", "inner#977"],
  [["run", "Skill", "Agent"].join(""), "the worker's skill run", "inner#977"],
  [["set", "Resolved", "Skills"].join(""), "the write of the skills a task ran", "inner#977"],
  [["selection", "guide"].join("_"), "the mode-picking prose skill prompts quoted", "inner#977"],
  [["skill", "agent", "max", "steps"].join("_"), "the step cap of a skill run", "inner#977"],
  [["skills", "Api"].join(""), "the web client of the skill routes", "inner#977"],
  [["Skill", "Meta"].join(""), "the shared type of a skill", "inner#977"],
];

/**
 * Nothing in the repository names deleted machinery.
 *
 * Two deletions are covered: PR-2 (the derived-agent concept, the five
 * filesystem and script tools, two skills and the plan-JSON path) and
 * inner#977 (the skill mechanism). A surviving mention either tells a reader
 * a capability exists when it does not, or makes the build or the code reach
 * for something that is no longer there.
 *
 * Scope is every tracked file whose bytes are text. That is subtraction from
 * the whole tree rather than a list of extensions to select from: residues
 * sit in files with no extension (a Dockerfile), in README, in `docs/` and in
 * each package's `CLAUDE.md`, and a list of paths misses some of them.
 *
 * Comments are not stripped, deliberately. A comment explaining how the
 * deleted machinery used to work still tells a reader it exists, and it does
 * not, so there is nothing left to describe.
 */
export const noSubagentResidue = {
  name: "no-subagent-residue",
  description: "Nothing names deleted machinery",
  run(context: CheckContext): Finding[] {
    if (DELETED_NAMES.length === 0) {
      throw new Error(
        "the deleted-name list is empty, so this check would match nothing",
      );
    }
    for (const [name] of DELETED_NAMES) {
      if (name === "") {
        throw new Error(
          "a deleted name is the empty string, which matches every line",
        );
      }
    }

    const files = context.textFiles(() => true, "tracked text files");

    const findings: Finding[] = [];
    for (const file of files) {
      const text = context.read(file);
      text.split("\n").forEach((line, index) => {
        for (const [name, what, deletedIn] of DELETED_NAMES) {
          if (!line.includes(name)) continue;
          findings.push({
            file,
            line: index + 1,
            message: `Names '${name}' — ${what}, deleted in ${deletedIn}. Either it misleads a reader into thinking the capability is still there, or it makes something reach for code that no longer exists.`,
          });
        }
      });
    }
    return findings;
  },
} satisfies Check;
