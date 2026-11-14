// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Start the ingest Worker, or step aside when this checkout has not configured
 * it yet.
 *
 * `wrangler.toml` is each developer's own copy of a template and never enters
 * the repo, so a fresh clone has none. Turbo runs every package's `dev` in one
 * group and a non-zero exit takes the whole group down: measured 2026-09-01,
 * moving the config aside and restarting left ports 8300, 3300 and 8787 all
 * unbound, with `@breatic/ingest#dev exited (1)` in the log. Someone who is not
 * working on uploads today would lose their frontend and their API over a
 * Worker they never configured, so this exits 0 and says what to copy.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const HERE = process.cwd();
const CONFIG = join(HERE, "wrangler.toml");

if (!existsSync(CONFIG)) {
  process.stdout.write(
    [
      "",
      "  ingest Worker: no wrangler.toml here, so it is not starting.",
      "",
      "  Uploads need it. To configure this checkout:",
      "    cp wrangler.toml.template wrangler.toml   # bucket, ports, addresses",
      "    cp .dev.vars.template .dev.vars           # the shared secret",
      "  then fill in the repo-root .env (see packages/ingest/README.md).",
      "",
      "  Everything else in `pnpm dev` is unaffected.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// Every top-level `[[containers]]` block has to name this copy (see README.md).
// One left unnamed builds the
// same image ID as any other unnamed copy on this machine, and each rebuild of
// one removes the tag the other's containers start from. Nothing reports that
// when it happens, so it is checked here.
const topLevel = readFileSync(CONFIG, "utf8").split(/^\[env\./m)[0] ?? "";
const blocks = topLevel
  .split(/^\[\[containers\]\]/m)
  .slice(1)
  .map((block) => block.split(/^\[/m)[0] ?? "");
const unnamed = blocks.filter((block) => !/^\s*image_vars\s*=\s*\{[^}]*\bDEV_COPY\s*=\s*"[^"<]+"/m.test(block));
if (unnamed.length > 0) {
  process.stdout.write(
    [
      "",
      `  ingest Worker: ${String(unnamed.length)} [[containers]] block(s) in wrangler.toml name no copy, so it is not starting.`,
      "",
      "  Add this line to each top-level [[containers]] block, with one name",
      "  no other copy of the repository on this machine uses:",
      '    image_vars = { DEV_COPY = "<this directory\'s name>" }',
      "  (see packages/ingest/README.md).",
      "",
      "  Everything else in `pnpm dev` is unaffected.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// The transition renderer is installed only by the `gl` variant of the Dockerfile. A
// MiniToolContainerGl block without it builds the standard image, which starts
// fine and then fails every Crossfade and Wipe export, so it is checked here.
const plainGl = blocks.filter(
  (block) =>
    /^\s*class_name\s*=\s*"MiniToolContainerGl"/m.test(block) &&
    !/^\s*image_vars\s*=\s*\{[^}]*\bVARIANT\s*=\s*"gl"/m.test(block),
);
if (plainGl.length > 0) {
  process.stdout.write(
    [
      "",
      "  ingest Worker: the MiniToolContainerGl block in wrangler.toml does not build the gl image, so it is not starting.",
      "",
      "  Give its image_vars the variant beside the copy name:",
      '    image_vars = { DEV_COPY = "<this directory\'s name>", VARIANT = "gl" }',
      "  (see packages/ingest/README.md).",
      "",
      "  Everything else in `pnpm dev` is unaffected.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const child = spawn("wrangler", ["dev"], { stdio: "inherit", shell: true });
child.on("exit", (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});
