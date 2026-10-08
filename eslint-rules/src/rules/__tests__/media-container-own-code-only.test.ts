// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { mediaContainerOwnCodeOnly } from "../media-container-own-code-only";

const ruleTester = new RuleTester();

/** The modules the container's tsconfig names, as the config passes them. */
const options: [{ bundledModules: string[] }] = [
  {
    bundledModules: [
      "@ingest/probe-command",
      "@ingest/probe-answer",
      "@ingest/jobs/op-args",
      "@shared/mini-tools/types",
    ],
  },
];

ruleTester.run("media-container-own-code-only", mediaContainerOwnCodeOnly, {
  valid: [
    // What the service is made of today: Node itself and the Worker's own
    // modules.
    { code: "import { createServer } from 'node:http';\nexport const s = createServer;" },
    { code: "import { execFile } from 'node:child_process';\nexport const e = execFile;" },
    { code: "import { previewArgs } from '@ingest/probe-command.js';\nexport const p = previewArgs;", options },
    { code: "import type { ProbeRequest } from '@ingest/probe-answer.js';\nexport type R = ProbeRequest;", options },
    // A module in a subdirectory, named by its path under the package.
    { code: "import { RUN_PATH } from '@ingest/jobs/op-args.js';\nexport const r = RUN_PATH;", options },
    // Our shared package is our own code too, when the tsconfig names it.
    { code: "import type { MiniToolOp } from '@shared/mini-tools/types.js';\nexport type O = MiniToolOp;", options },
    // The tools are named by string arguments, which are not imports.
    { code: "export const program = 'vips';" },
  ],
  invalid: [
    {
      // tsc and esbuild follow this import past the tsconfig's list, so a
      // module the guard never reads would be bundled into the service.
      code: "import { thumb } from '@ingest/thumb.js';\nexport const t = thumb;",
      options,
      errors: [{ messageId: "notBundled" }],
    },
    {
      // A shared module the tsconfig does not name is bundled unread too.
      code: "import { newId } from '@shared/ids.js';\nexport const n = newId;",
      options,
      errors: [{ messageId: "notBundled" }],
    },
    {
      // A binding loads libvips into this process; the image's libvips links
      // GPL libraries.
      code: "import sharp from 'sharp';\nexport const s = sharp;",
      errors: [{ messageId: "notOwnCode", line: 1, column: 1 }],
    },
    {
      code: "export const later = async () => await import('wasm-vips');",
      errors: [{ messageId: "notOwnCode" }],
    },
    {
      code: "import ffmpeg from 'fluent-ffmpeg';\nexport const f = ffmpeg;",
      errors: [{ messageId: "notOwnCode" }],
    },
    {
      // A builtin reached without its prefix reads the same as a package.
      code: "import { createServer } from 'http';\nexport const s = createServer;",
      errors: [{ messageId: "notOwnCode" }],
    },
    {
      code: "export { default } from 'some-package';",
      errors: [{ messageId: "notOwnCode" }],
    },
  ],
});
