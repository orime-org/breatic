// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { isScannableText, isTextContent } from "#repo-lint/file-kinds";

/**
 * Nothing drops out of the content scans without being named.
 *
 * Every check that asks "does this file contain X" starts from the whole
 * working tree and subtracts what it cannot read, in two steps: kinds nobody
 * needs to open, and then whatever turns out not to be text once opened. The
 * first step is a written list, so a subtraction there is on the record. The
 * second was not: a file that failed the content sniff simply stopped
 * appearing, in six scans at once, and looked from the outside exactly like a
 * file with nothing in it — which is the one shape of failure this whole
 * suite exists to remove.
 *
 * So the second step is put on the record too. The finding does not presume
 * which of the two cases it is, because the right fix differs: a genuinely
 * binary kind belongs on the list, while a file that was meant to be text is
 * not valid UTF-8 and needs fixing rather than listing. Either way somebody
 * decides, instead of six scans quietly agreeing to look away.
 *
 * On this repository it reports nothing, and that is the point — the number
 * it prints is the number of files nobody has to wonder about.
 */
export const noSilentSkip = {
  name: "no-silent-skip",
  description: "Nothing drops out of the content scans unannounced",
  run(context: CheckContext): Finding[] {
    const opened = context.files(
      (path) => isScannableText(path),
      "files no listed binary kind accounts for",
    );

    const findings: Finding[] = [];
    for (const file of opened) {
      if (isTextContent(context.read(file))) continue;
      findings.push({
        file,
        message:
          "this file was opened and is not text, so every content scan — secrets, trojan source, forbidden tokens — passed over it silently. If its kind is binary, name that kind so it is never opened; if it is meant to be text, it is not valid UTF-8 and nothing can see what is inside it.",
      });
    }
    return findings;
  },
} satisfies Check;
