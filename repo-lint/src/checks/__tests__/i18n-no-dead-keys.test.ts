// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { i18nNoDeadKeys } from "#repo-lint/checks/i18n-no-dead-keys";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Builds a context over one catalog plus the sources that may reference it.
 * @param body The English catalog.
 * @param sources Repo-relative path to contents, for everything else.
 * @returns A context the check can run against.
 */
function repo(body: Record<string, unknown>, sources: Record<string, string>) {
  return fakeContext({ "locales/en.json": JSON.stringify(body), ...sources });
}

describe("i18n-no-dead-keys", () => {
  it("passes a key some file names in full", () => {
    expect(
      i18nNoDeadKeys.run(
        repo(
          { canvas: { upload: { tooLarge: "Too large" } } },
          { "packages/web/src/a.tsx": "t('canvas.upload.tooLarge')" },
        ),
      ),
    ).toEqual([]);
  });

  it("catches a key nothing names", () => {
    const findings = i18nNoDeadKeys.run(
      repo(
        { canvas: { upload: { tooLarge: "Too large" }, gone: "Gone" } },
        { "packages/web/src/a.tsx": "t('canvas.upload.tooLarge')" },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("canvas.gone");
  });

  it("keeps every key an interpolated id can reach", () => {
    // t(`canvas.upload.${rejection}`) names none of these in full, and all of
    // them are live. This is the case a literal-only scan gets wrong.
    expect(
      i18nNoDeadKeys.run(
        repo(
          { canvas: { upload: { tooLarge: "a", tooMany: "b", badType: "c" } } },
          { "packages/web/src/a.tsx": "t(`canvas.upload.${rejection}`)" },
        ),
      ),
    ).toEqual([]);
  });

  it("does not let a prefix reach a sibling subtree with the same head", () => {
    // `canvas.upload.` must not keep `canvas.uploadLegacy.*` alive: the
    // trailing dot is what stops one namespace from covering its neighbour.
    const findings = i18nNoDeadKeys.run(
      repo(
        {
          canvas: {
            upload: { tooLarge: "a" },
            uploadLegacy: { tooLarge: "b" },
          },
        },
        { "packages/web/src/a.tsx": "t(`canvas.upload.${rejection}`)" },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("canvas.uploadLegacy.tooLarge");
  });

  it("does not count a key's own catalog entry as a use", () => {
    // Every key appears in every catalog by definition. Scanning them would
    // make the check pass unconditionally — the failure mode this exists to
    // avoid, since a check that cannot fail reads exactly like a clean repo.
    const findings = i18nNoDeadKeys.run(
      fakeContext({
        "locales/en.json": JSON.stringify({ canvas: { gone: "Gone" } }),
        "locales/ja.json": JSON.stringify({ canvas: { gone: "消えた" } }),
        "packages/web/src/a.tsx": "export const a = 1;",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("canvas.gone");
  });

  it("keeps a flat top-level key its translation call names", () => {
    // Regression: the first version only indexed dotted identifiers, so a
    // dotless key could not be found however often it was used. It deleted
    // `cancel` and `loading` — both live — and the two tests that caught it
    // were the only thing between that and shipping raw ids to the UI.
    expect(
      i18nNoDeadKeys.run(
        repo(
          { cancel: "Cancel", loading: "Loading…" },
          {
            "packages/web/src/a.tsx":
              "<Button>{t('cancel')}</Button><Spinner aria-label={t(\"loading\")} />",
          },
        ),
      ),
    ).toEqual([]);
  });

  it("still catches a flat top-level key no call names", () => {
    // The other half: matching dotless keys must not degrade into "does this
    // word appear anywhere", which would exempt every short key forever.
    const findings = i18nNoDeadKeys.run(
      repo(
        { cancel: "Cancel", next: "Next" },
        { "packages/web/src/a.tsx": "t('cancel'); params.get('next');" },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("next");
  });

  it("does not let a __tests__ directory keep a key alive", () => {
    // Pins one half of the exclusion on its own. The path below is NOT named
    // *.test.ts, so a version that dropped the directory half would report
    // nothing here — which is exactly the mutation an earlier round of tests
    // let through, because every fixture path happened to match both halves.
    const findings = i18nNoDeadKeys.run(
      repo(
        { spaces: { drawer: { newCanvas: "New canvas" } } },
        {
          "packages/web/src/i18n/__tests__/fixtures.ts":
            "export const rows = ['spaces.drawer.newCanvas'];",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("spaces.drawer.newCanvas");
  });

  it("does not let a .test file outside __tests__ keep a key alive", () => {
    // The other half, pinned the same way: a path that matches the suffix and
    // not the directory.
    const findings = i18nNoDeadKeys.run(
      repo(
        { spaces: { drawer: { newCanvas: "New canvas" } } },
        {
          "packages/web/src/spaces.test.ts": "t('spaces.drawer.newCanvas')",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
  });

  it("keeps a key that only test scaffolding names, and that is deliberate", () => {
    // The naming convention does not reach a helper kept beside the code it
    // serves, so this one stays in the scan and its mention counts. A content
    // sniff for the vitest import was tried and reverted: it dropped a shipped
    // component over a comment mentioning the phrase, reporting 37 live keys
    // for deletion, and still missed core's db/test-support.ts. The residual
    // here is the cheap direction — a dead key survives a sweep. The fix, if
    // it ever bites, is to move the helper into __tests__.
    expect(
      i18nNoDeadKeys.run(
        repo(
          { members: { stack: { removeAria: "Remove {name}" } } },
          {
            "packages/web/src/test-utils/a11y.ts":
              "export const K = 'members.stack.removeAria';",
            "packages/web/src/app.tsx": "export const App = () => null;",
          },
        ),
      ),
    ).toEqual([]);
  });

  it("does not let a .test.mts file keep a key alive", () => {
    // Widening the scan to every TypeScript extension opened a seam: the
    // shared TEST_FILE only knew .ts/.tsx, so a test file with the newer
    // extension read as application code. Both patterns now cover the same
    // extensions, and this pins that they agree.
    const findings = i18nNoDeadKeys.run(
      repo(
        { spaces: { drawer: { newCanvas: "New canvas" } } },
        {
          "packages/web/src/thing.test.mts":
            "const rows = ['spaces.drawer.newCanvas'];",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("spaces.drawer.newCanvas");
  });

  it("scans a package source that is not under src's default extension set", () => {
    // Pins the extension half: a .mts module under src is application code.
    // The repo has .mts files today (all at package root), so the shape is
    // live even though none sits under src yet.
    expect(
      i18nNoDeadKeys.run(
        repo(
          { canvas: { ready: "Ready" } },
          { "packages/web/src/boot.mts": "t('canvas.ready')" },
        ),
      ),
    ).toEqual([]);
  });

  it("does not scan this check's own source", () => {
    // repo-lint keeps its source at <root>/src, one level above the shape the
    // pattern matches, so it falls out on depth. This is the case that
    // matters in practice — the check must not read its own worked examples.
    const findings = i18nNoDeadKeys.run(
      repo(
        { canvas: { ready: "Ready" } },
        {
          "repo-lint/src/checks/example.ts": "// e.g. t('canvas.ready')",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("canvas.ready");
  });

  it("does not scan a package-shaped tree outside packages/", () => {
    // Pins the `packages/` word itself, which depth alone does not enforce:
    // a workspace laid out the same way somewhere else is still out of scope.
    // Deliberate, and the risky direction — if such a workspace ever ships
    // code that reads the catalogs, widen the pattern rather than exempting
    // its keys, because being invisible here means being reported dead.
    const findings = i18nNoDeadKeys.run(
      repo(
        { canvas: { ready: "Ready" } },
        {
          "tools/console/src/app.ts": "t('canvas.ready')",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("canvas.ready");
  });

  it("does not let a test fixture keep a key alive", () => {
    // A test that names a key nobody reads is not evidence the key is used —
    // it is a second dead thing, and counting it means the sweep can never
    // reach either. Measured on the real catalogs: 12 keys were held up by
    // nothing but test fixtures.
    const findings = i18nNoDeadKeys.run(
      repo(
        { spaces: { drawer: { newCanvas: "New canvas" } } },
        {
          "packages/web/src/i18n/__tests__/frozen-product-terms.test.ts":
            "['spaces.drawer.newCanvas', 'Canvas']",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("spaces.drawer.newCanvas");
  });

  it("does not let a spec document keep a key alive", () => {
    // Prose naming a key is documentation of the key, not a reader of it. If
    // the key goes, that sentence should go with it — which cannot happen
    // while the sentence is what protects the key.
    const findings = i18nNoDeadKeys.run(
      repo(
        { project: { toolbar: { uploadFile: "Upload" } } },
        {
          "packages/web/CLAUDE.md": "例:上传文件的 project.toolbar.uploadFile",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("project.toolbar.uploadFile");
  });

  it("does not let this check's own source keep a key alive", () => {
    // The worst case, because it is silent and total: this file's docstring
    // uses `canvas.upload` as its worked example, so scanning itself made
    // every key in that namespace permanently unreportable — the guard
    // issuing itself a pass over exactly the namespace it teaches with.
    const findings = i18nNoDeadKeys.run(
      repo(
        { canvas: { upload: { tooLarge: "Too large" } } },
        {
          "repo-lint/src/checks/i18n-no-dead-keys.ts":
            "// e.g. t(`canvas.upload.${rejection}`) keeps every key under it",
          "packages/web/src/app.tsx": "export const App = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("canvas.upload.tooLarge");
  });

  it("counts any mention inside an application source, quoted or not", () => {
    // Within the scanned scope the matching stays generous — a bare dotted
    // literal is enough, no call shape required — because calling a live key
    // dead deletes real UI text while calling a dead key live only postpones
    // a cleanup.
    expect(
      i18nNoDeadKeys.run(
        repo(
          { server: { mail: { subject: "Welcome" } } },
          {
            "packages/server/src/mail.ts":
              "// the subject comes from server.mail.subject",
          },
        ),
      ),
    ).toEqual([]);
  });

  it("does not count a config file, because nothing outside TypeScript reads a key", () => {
    // Verified when the scope was set: no tracked non-TS, non-Markdown file
    // names a catalog key. If one ever does, this check reports the key and
    // the fix is a DYNAMIC_KEY_ROOTS entry stating why the scan cannot see
    // it — an escape hatch that demands a written reason, rather than a scope
    // quietly wide enough to swallow prose.
    const findings = i18nNoDeadKeys.run(
      repo(
        { server: { mail: { subject: "Welcome" } } },
        {
          "config/mail.yaml": "template: server.mail.subject",
          "packages/server/src/mail.ts": "export const send = () => null;",
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("server.mail.subject");
  });

  it("reads the English catalog only, so a stale translation cannot hide a death", () => {
    // A key deleted from en.json but left in ja.json is not a live key. The
    // check would silently shrink to the translations' intersection if it
    // took its key list from whichever catalog it happened to read.
    expect(
      i18nNoDeadKeys.run(
        fakeContext({
          "locales/en.json": JSON.stringify({ canvas: { kept: "Kept" } }),
          "locales/ja.json": JSON.stringify({
            canvas: { kept: "維持", stale: "古い" },
          }),
          "packages/web/src/a.tsx": "t('canvas.kept')",
        }),
      ),
    ).toEqual([]);
  });
});
