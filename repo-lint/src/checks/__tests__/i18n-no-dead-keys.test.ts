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

  it("counts a mention outside the frontend, quotes or not", () => {
    // The scan is deliberately generous: calling a live key dead deletes real
    // UI text, while calling a dead key live only postpones a cleanup.
    expect(
      i18nNoDeadKeys.run(
        repo(
          { server: { mail: { subject: "Welcome" } } },
          { "config/mail.yaml": "template: server.mail.subject" },
        ),
      ),
    ).toEqual([]);
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
