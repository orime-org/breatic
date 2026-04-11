/**
 * Tests for the file-tool sandbox.
 *
 * These tests exercise {@link assertInSandbox} directly against a
 * temporary directory configured via the `FILE_TOOL_SANDBOX_DIR` env
 * var. The key properties we pin:
 *
 *   - Paths inside the sandbox resolve and return
 *   - Absolute paths outside the sandbox are rejected
 *   - `..` traversal is rejected even if it stays within `<root>`
 *     textually
 *   - Symlink escapes are rejected
 *   - Prefix-match tricks like `<root>-sibling` are rejected
 *   - Non-existent files inside the sandbox are accepted (for write)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as FsSandboxModule from "../../../agent/tools/fs-sandbox.js";

// We need to set the sandbox dir BEFORE importing the module so its
// module-scoped initializer picks it up.
let tmpRoot: string;
let sandboxDir: string;
// Real sandbox path after symlink resolution — used for building
// expected values since the module realpaths its root (macOS
// `/var` → `/private/var`).
let realSandboxDir: string;
let siblingDir: string;
let realSiblingDir: string;
let sandbox: typeof FsSandboxModule;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "breatic-sandbox-test-"));
  sandboxDir = join(tmpRoot, "workspace");
  siblingDir = join(tmpRoot, "workspace-sibling");
  await mkdir(sandboxDir, { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await writeFile(join(siblingDir, "secret.txt"), "top-secret");

  realSandboxDir = await realpath(sandboxDir);
  realSiblingDir = await realpath(siblingDir);

  process.env.FILE_TOOL_SANDBOX_DIR = sandboxDir;
  // Reset the module cache so fs-sandbox.ts re-evaluates SANDBOX_ROOT
  // with our FILE_TOOL_SANDBOX_DIR override.
  sandbox = await import("../../../agent/tools/fs-sandbox.js");
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("assertInSandbox", () => {
  it("accepts a relative path inside the sandbox", async () => {
    const resolved = await sandbox.assertInSandbox("notes.txt");
    expect(resolved).toBe(join(realSandboxDir, "notes.txt"));
  });

  it("accepts an absolute path that points inside the sandbox", async () => {
    const resolved = await sandbox.assertInSandbox(join(sandboxDir, "a", "b.txt"));
    expect(resolved).toBe(join(realSandboxDir, "a", "b.txt"));
  });

  it("accepts a non-existent file (for write_file) whose parent exists", async () => {
    const resolved = await sandbox.assertInSandbox("new-file.txt");
    expect(resolved).toBe(join(realSandboxDir, "new-file.txt"));
  });

  it("rejects an absolute path outside the sandbox", async () => {
    await expect(sandbox.assertInSandbox("/etc/passwd")).rejects.toThrow(
      sandbox.SandboxError,
    );
  });

  it("rejects a relative path that escapes via ..", async () => {
    await expect(sandbox.assertInSandbox("../../../etc/passwd")).rejects.toThrow(
      sandbox.SandboxError,
    );
  });

  it("rejects a relative path that escapes via .. even to a sibling", async () => {
    await expect(
      sandbox.assertInSandbox("../workspace-sibling/secret.txt"),
    ).rejects.toThrow(sandbox.SandboxError);
  });

  it("rejects prefix-match escape (sandbox-sibling directory)", async () => {
    // sandboxDir is "<tmp>/workspace"; this path is "<tmp>/workspace-sibling/..."
    // which textually starts with sandboxDir but is a different directory.
    await expect(
      sandbox.assertInSandbox(join(realSiblingDir, "secret.txt")),
    ).rejects.toThrow(sandbox.SandboxError);
  });

  it("rejects a symlink that escapes the sandbox", async () => {
    // Create a symlink inside the sandbox pointing outside.
    const linkPath = join(sandboxDir, "escape-link");
    await symlink(siblingDir, linkPath);

    // Following the link resolves to siblingDir, which is outside.
    await expect(
      sandbox.assertInSandbox("escape-link/secret.txt"),
    ).rejects.toThrow(sandbox.SandboxError);
  });

  it("rejects empty-string paths", async () => {
    await expect(sandbox.assertInSandbox("")).rejects.toThrow(
      sandbox.SandboxError,
    );
  });
});
