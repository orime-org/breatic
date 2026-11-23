// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** The push parsers of probe-image-size 7.5.0 (`lib/formats/*.js`), which ship no type declarations. */
interface ProbeImageParser {
  /** Feed the next bytes; parsing stops once it is done or failed. */
  push(chunk: Uint8Array): void;
  /** 0 while it needs more bytes, 1 when done, 2 when the bytes are not this format. */
  getStatus(): 0 | 1 | 2;
  /** The size, set as soon as it is read. */
  result?: { width: number; height: number; type: string };
}

declare module 'probe-image-size/lib/formats/jpeg.js' {
  const format: { Parser: new () => ProbeImageParser };
  export default format;
}
declare module 'probe-image-size/lib/formats/png.js' {
  const format: { Parser: new () => ProbeImageParser };
  export default format;
}
declare module 'probe-image-size/lib/formats/webp.js' {
  const format: { Parser: new () => ProbeImageParser };
  export default format;
}
