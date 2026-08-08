// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every name PR-2 deleted, paired with what it was.
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
export const DELETED_NAMES: ReadonlyArray<readonly [string, string]> = [
  // The dispatch machinery.
  [["spawn", "Tool"].join(""), "the dispatch tool that ran a derived agent"],
  [["spawn", "Count"].join(""), "the per-turn counter that numbered those runs"],
  [["agent", "loader"].join("-"), "the module that read the agent definitions"],
  [["load", "Agents"].join(""), "the agent-definition loader"],
  [["list", "Agents"].join(""), "the agent-definition lister"],
  [["sub", "agent"].join("-"), "the deleted concept, hyphenated"],
  [["Sub", "Agent"].join(""), "the deleted concept, in a symbol"],
  // The five filesystem and script tools, and what supported them.
  [["run", "script"].join("_"), "the script-execution tool"],
  [["read", "file"].join("_"), "the file-read tool"],
  [["write", "file"].join("_"), "the file-write tool"],
  [["edit", "file"].join("_"), "the file-edit tool"],
  [["list", "dir"].join("_"), "the directory-listing tool"],
  [["fs", "sandbox"].join("-"), "the sandbox the file tools ran inside"],
  [
    ["FILE", "TOOL", "SANDBOX", "DIR"].join("_"),
    "the env var that configured that sandbox",
  ],
  [["DEFAULT", "TOOLS"].join("_"), "the tool-set constant with no consumers"],
  // The two deleted skills.
  [["skill", "creator"].join("_"), "the skill that let users author skills"],
  [["a", "fame"].join(""), "the skill whose script the deleted tool ran"],
  // The superseded plan-JSON path.
  [["extract", "Plan"].join(""), "the function that scraped plan JSON from text"],
  [["chat", "plan"].join("_"), "the SSE event that carried that JSON"],
  [["task", "plan"].join("_"), "the skill output type that produced it"],
];

/**
 * Nothing in the repository names what PR-2 deleted.
 *
 * The deleted concept, the five filesystem and script tools, the two skills
 * that used them, and the plan-JSON path are gone. A surviving mention either
 * tells a reader a capability exists when it does not, or — in a Dockerfile
 * `COPY` or a skill's declared tools — makes the build or the assembly reach
 * for something that is no longer there.
 *
 * Scope is every tracked file whose bytes are text. That is subtraction from
 * the whole tree rather than a list of extensions to select from, which
 * matters here: the residues sit in a Dockerfile with no extension, in README,
 * in `docs/`, in the skills' JSON, and in each package's `CLAUDE.md`. The
 * design doc's first draft of this check listed paths and missed the
 * repository-root `CLAUDE.md` and `skills/` — a list would have gone green
 * while both still named the deleted things.
 *
 * Comments are not stripped, deliberately. A comment explaining how the
 * deleted machinery used to work still tells a reader it exists, and it does
 * not, so there is nothing left to describe.
 */
export const noSubagentResidue = {
  name: "no-subagent-residue",
  description: "Nothing names what PR-2 deleted",
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
        for (const [name, what] of DELETED_NAMES) {
          if (!line.includes(name)) continue;
          findings.push({
            file,
            line: index + 1,
            message: `Names '${name}' — ${what}, deleted in PR-2. Either it misleads a reader into thinking the capability is still there, or it makes something reach for code that no longer exists.`,
          });
        }
      });
    }
    return findings;
  },
} satisfies Check;
