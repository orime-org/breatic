// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noFfmpegBindings } from "../no-ffmpeg-bindings";

const ruleTester = new RuleTester();

ruleTester.run("no-ffmpeg-bindings", noFfmpegBindings, {
  valid: [
    // How every call site reaches ffmpeg today: a spawned process, named by a
    // string argument.
    {
      code: "import { spawnCollected } from '@worker/lib/spawn';\nexport const cut = async (a: string[]) => await spawnCollected('ffmpeg', a);",
    },
    // The word in prose. 172 lines of this repository carry it.
    {
      code: "/** ffprobe reads the duration, then ffmpeg writes the clip. */\nexport const note = 1;",
    },
    // A test fixture that contains source text as a string.
    {
      code: "export const fixture = 'import ffmpeg from \"fluent-ffmpeg\";';",
    },
    // Our own modules, reached relatively and by subpath import.
    { code: "import { args } from './ffmpeg-args.js';\nexport const a = args;" },
    { code: "import { c } from '#rules/ffmpeg-helper';\nexport const b = c;" },
  ],
  invalid: [
    {
      code: "import ffmpeg from 'fluent-ffmpeg';\nexport const f = ffmpeg;",
      errors: [{ messageId: "noBinding", line: 1, column: 1 }],
    },
    {
      // A binding reached only for its types still installs the library.
      code: "import type { FfmpegCommand } from 'fluent-ffmpeg';\nexport type C = FfmpegCommand;",
      errors: [{ messageId: "noBinding", line: 1, column: 1 }],
    },
    {
      code: "export const later = async () => await import('@ffmpeg/ffmpeg');",
      errors: [{ messageId: "noBinding" }],
    },
    {
      code: "const path = require('ffmpeg-static');\nexport const p = path;",
      errors: [{ messageId: "noBinding" }],
    },
    {
      code: "export { default } from 'ffmpeg-static';",
      errors: [{ messageId: "noBinding" }],
    },
    {
      // The other words the rule reads, on packages that wrap the libraries
      // directly rather than the executable.
      code: "import { Decoder } from 'libavjs';\nexport const d = Decoder;",
      errors: [{ messageId: "noBinding" }],
    },
  ],
});
