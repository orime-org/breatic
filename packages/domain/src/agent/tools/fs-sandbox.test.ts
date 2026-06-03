// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Sandbox escape regression tests for the agent file tools.
 *
 * The whole point of {@link assertInSandbox} is that no agent-driven
 * path — absolute, `..`-traversal, or symlink — can read or write
 * outside the sandbox root (notably the repo-root `.env`). The
 * env-injection refactor (2026-05-30) moved how the sandbox root is
 * acquired (`env.FILE_TOOL_SANDBOX_DIR` now resolves through the
 * injected config Proxy instead of a direct `process.env` read), so
 * these tests lock the protection in place across that change.
 *
 * See memory `reference_agent_tool_sandbox_env_protection`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCore } from "@breatic/core";
import {
  assertInSandbox,
  getSandboxRoot,
  SandboxError,
} from "@domain/agent/tools/fs-sandbox.js";

let base: string;
let sandboxDir: string;
let outsideSecret: string;

beforeAll(() => {
  // Isolate the sandbox in a temp dir so escape assertions don't
  // depend on the repo layout. Re-inject config with this dir;
  // fs-sandbox reads env.FILE_TOOL_SANDBOX_DIR lazily on first use,
  // and this test file is module-isolated by vitest so the lazy
  // root hasn't been computed yet.
  base = mkdtempSync(join(tmpdir(), "breatic-sandbox-test-"));
  sandboxDir = join(base, "sandbox");
  mkdirSync(sandboxDir, { recursive: true });

  // A secret file OUTSIDE the sandbox (sibling), standing in for the
  // repo-root `.env` an attacker would try to exfiltrate.
  outsideSecret = join(base, ".env");
  writeFileSync(outsideSecret, "SECRET=should-never-be-readable\n");

  initCore({ ...process.env, FILE_TOOL_SANDBOX_DIR: sandboxDir });
});

afterAll(() => {
  // Restore default config for tidiness; remove the temp tree.
  initCore({ ...process.env });
  rmSync(base, { recursive: true, force: true });
});

describe("assertInSandbox", () => {
  it("resolves the configured sandbox dir (realpath-normalized)", () => {
    expect(getSandboxRoot()).toBe(realpathSync(sandboxDir));
  });

  it("allows a relative path inside the sandbox", async () => {
    const resolved = await assertInSandbox("notes.txt");
    expect(resolved.startsWith(realpathSync(sandboxDir))).toBe(true);
  });

  it("allows creating a new file under an existing sandbox subdir", async () => {
    mkdirSync(join(sandboxDir, "sub"), { recursive: true });
    const resolved = await assertInSandbox("sub/new-file.txt");
    expect(resolved.startsWith(realpathSync(sandboxDir))).toBe(true);
  });

  it("rejects an absolute path outside the sandbox (the .env secret)", async () => {
    await expect(assertInSandbox(outsideSecret)).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it("rejects a `..` traversal escaping to the sibling .env", async () => {
    await expect(assertInSandbox("../.env")).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it("rejects a deep `..` traversal to /etc/passwd", async () => {
    await expect(
      assertInSandbox("../../../../../../etc/passwd"),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects a symlink inside the sandbox pointing outside it", async () => {
    const link = join(sandboxDir, "escape-link");
    symlinkSync(outsideSecret, link);
    await expect(assertInSandbox("escape-link")).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it("rejects a sibling dir that shares the sandbox name prefix", async () => {
    // `<sandbox>-escape/x` must not pass the `<sandbox>` prefix check;
    // the separator boundary prevents `/sandbox-escape` ~ `/sandbox`.
    const sibling = `${sandboxDir}-escape`;
    mkdirSync(sibling, { recursive: true });
    await expect(
      assertInSandbox(join(sibling, "x.txt")),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects an empty path", async () => {
    await expect(assertInSandbox("")).rejects.toBeInstanceOf(SandboxError);
  });
});
