// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProjectMediaBackfillOptions } from "../backfill-project-media-options.ts";

const OUTPUT = "private-reports/project-media.jsonl";
const RESUME = ["--resume-pass", "initial", "--resume-source", "grants", "--resume-cursor", "last-successful-row"];

test("defaults an explicit JSONL destination to report mode", () => {
  assert.deepEqual(parseProjectMediaBackfillOptions(["--output", OUTPUT]), { help: false, mode: "report", outputPath: OUTPUT });
});

test("selects apply mode only when the operator supplies --apply", () => {
  assert.deepEqual(parseProjectMediaBackfillOptions(["--apply", "--output", OUTPUT]), { help: false, mode: "apply", outputPath: OUTPUT });
});

test("accepts an inline output value and preserves its complete value after the first equals sign", () => {
  const outputPath = "private-reports/key=value=result.jsonl";
  assert.deepEqual(parseProjectMediaBackfillOptions(["--output=" + outputPath]), { help: false, mode: "report", outputPath });
});

test("accepts the apply flag after the output argument", () => {
  assert.deepEqual(parseProjectMediaBackfillOptions(["--output", OUTPUT, "--apply"]), { help: false, mode: "apply", outputPath: OUTPUT });
});

for (const outputPath of [".jsonl", "./report.jsonl", "../reports/report.jsonl", "/operator-chosen/path/report.jsonl", "C:\\private reports\\result.jsonl", " leading space.jsonl", "folder with spaces/result.jsonl", ".env.jsonl"]) {
  test("preserves the operator-selected JSONL path " + JSON.stringify(outputPath), () => {
    assert.deepEqual(parseProjectMediaBackfillOptions(["--output", outputPath]), { help: false, mode: "report", outputPath });
  });
}

for (const pass of ["initial", "verification"]) {
  test("parses a complete " + pass + " resume position", () => {
    assert.deepEqual(parseProjectMediaBackfillOptions(["--output", OUTPUT, "--resume-pass", pass, "--resume-source", "operator-selected-source", "--resume-cursor", "2026-10-25 03:10:21.123456+00|original-id"]), {
      help: false, mode: "report", outputPath: OUTPUT,
      resume: { pass, source: "operator-selected-source", cursor: "2026-10-25 03:10:21.123456+00|original-id" },
    });
  });
}

test("preserves nonempty whitespace source and cursor values", () => {
  assert.deepEqual(parseProjectMediaBackfillOptions(["--output", OUTPUT, "--resume-pass", "initial", "--resume-source", " ", "--resume-cursor", "\t "]), {
    help: false, mode: "report", outputPath: OUTPUT, resume: { pass: "initial", source: " ", cursor: "\t " },
  });
});

test("parses frozen arguments while preserving their original order and values", () => {
  const args = Object.freeze(["--output", OUTPUT, ...RESUME, "--apply"]);
  const before = [...args];
  assert.deepEqual(parseProjectMediaBackfillOptions(args), { help: false, mode: "apply", outputPath: OUTPUT, resume: { pass: "initial", source: "grants", cursor: "last-successful-row" } });
  assert.deepEqual(args, before);
});

test("returns help when the output argument is absent", () => {
  assert.deepEqual(parseProjectMediaBackfillOptions(["--help"]), { help: true });
});

test("returns help when apply is also supplied without an output destination", () => {
  assert.deepEqual(parseProjectMediaBackfillOptions(["--apply", "--help"]), { help: true });
});

for (const flag of ["--unknown", "--report", "--mode=apply", "--OUTPUT=report.jsonl", "-h", "-o"]) {
  for (const helpPosition of ["absent", "before", "after"]) {
    test("rejects unknown flag " + flag + " with help " + helpPosition, () => {
      const args = ["--output", OUTPUT, flag];
      if (helpPosition === "before") args.unshift("--help");
      if (helpPosition === "after") args.push("--help");
      assert.throws(() => parseProjectMediaBackfillOptions(args), /unknown.*option|unknown.*argument|unexpected.*option/i);
    });
  }
}

for (const positionals of [["stray-position"], ["--", "--apply"], ["--", "another.jsonl"], ["--help", "stray-position"]]) {
  test("rejects positional arguments " + JSON.stringify(positionals), () => {
    assert.throws(() => parseProjectMediaBackfillOptions(["--output", OUTPUT, ...positionals]), /positional|unexpected.*argument|argument.*unexpected/i);
  });
}

for (const flag of ["--apply=false", "--apply=true", "--apply=", "--help=false", "--help=true", "--help="]) {
  test("rejects a value assigned to boolean option " + flag, () => {
    assert.throws(() => parseProjectMediaBackfillOptions(["--output", OUTPUT, flag]), /--apply|--help|boolean|does not take an argument/i);
  });
}

for (const outputPath of ["", " ", "report", "report.txt", "report.json", "report.JSONL", "report.jsonl ", ".env", "report.jsonl/another-file"]) {
  test("rejects an invalid output destination " + JSON.stringify(outputPath), () => {
    assert.throws(() => parseProjectMediaBackfillOptions(["--output=" + outputPath]), /output|jsonl/i);
  });
}

for (const args of [[], ["--apply"], ["--output"]]) {
  test("requires an output value for arguments " + JSON.stringify(args), () => {
    assert.throws(() => parseProjectMediaBackfillOptions(args), /output/i);
  });
}

const RESUME_PARTS = [["--resume-pass", "initial"], ["--resume-source", "grants"], ["--resume-cursor", "original-cursor"]];
for (const mask of [1, 2, 3, 4, 5, 6]) {
  test("rejects incomplete resume tuple " + mask, () => {
    const partial = RESUME_PARTS.flatMap((part, index) => (mask & (1 << index)) === 0 ? [] : part);
    assert.throws(() => parseProjectMediaBackfillOptions(["--output", OUTPUT, ...partial]), /resume/i);
  });
}

for (const pass of ["", "later-pass", "INITIAL", "verification ", " initial", "verify"]) {
  test("rejects an unknown resume pass " + JSON.stringify(pass), () => {
    assert.throws(() => parseProjectMediaBackfillOptions(["--output", OUTPUT, "--resume-pass=" + pass, "--resume-source", "grants", "--resume-cursor", "cursor"]), /resume|initial|verification/i);
  });
}

for (const emptyFlag of ["--resume-source", "--resume-cursor"]) {
  test("requires a nonempty value for " + emptyFlag, () => {
    const args = ["--output", OUTPUT, "--resume-pass", "initial", "--resume-source=grants", "--resume-cursor=cursor"].map((arg) => arg.startsWith(emptyFlag + "=") ? emptyFlag + "=" : arg);
    assert.throws(() => parseProjectMediaBackfillOptions(args), /resume|source|cursor/i);
  });
}

const DUPLICATE_ARGUMENTS = [
  ["--apply", "--apply"],
  ["--help", "--help"],
  ["--output", "another.jsonl"],
  [...RESUME, "--resume-pass", "initial"],
  [...RESUME, "--resume-source=grants"],
  [...RESUME, "--resume-cursor=last-successful-row"],
  ["--output=another.jsonl"],
];
for (const duplicate of DUPLICATE_ARGUMENTS) {
  test("rejects repeated option occurrences " + JSON.stringify(duplicate), () => {
    assert.throws(() => parseProjectMediaBackfillOptions(["--output", OUTPUT, ...duplicate]), /duplicate|repeat|more than once|only once/i);
  });
}

test("preserves multilingual and punctuation values across a fixed roundtrip corpus", () => {
  const corpus = ["plain", " ", "two words", "汉字", "日本語", "emoji🎞️", "line\nbreak", "tab\tvalue", "double\"single'", "back\\slash", '{"cursor":"\\\\quoted"}', "=value", "--looks-like-a-flag", "$(literal-command)", "\u0060literal-command\u0060"];
  for (const source of corpus) {
    for (const cursor of corpus) {
      const outputPath = "operator-selected/" + source + "/" + cursor + ".jsonl";
      const args = Object.freeze(["--output=" + outputPath, "--resume-pass=verification", "--resume-source=" + source, "--resume-cursor=" + cursor]);
      assert.deepEqual(parseProjectMediaBackfillOptions(args), { help: false, mode: "report", outputPath, resume: { pass: "verification", source, cursor } });
    }
  }
});
