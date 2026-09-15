// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every format we take, read off bytes a real encoder wrote (#240).
 *
 * The other sniffing tests hand-build headers, and a hand-built header proves
 * less than it looks: a PNG signature assembled by hand answered `undefined`
 * here until the IHDR chunk was placed where a real writer places it, and the
 * fault was in the fixture. These samples are the first 64 bytes of files
 * ffmpeg 7.1.1 produced, so what they measure is what an encoder in the wild
 * actually emits.
 *
 * 64 bytes rather than whole files, because that is enough for every container
 * below and it keeps the fixtures readable. The lane reads 4100 (file-type's
 * own `reasonableDetectionSizeInBytes`), so the margin is wide.
 */

import { describe, expect, it } from "vitest";

import {
  isStorableMediaType,
  isUploadableMediaType,
} from "@shared/upload/media-type.js";
import { sniffMimeType } from "@shared/upload/sniff-mime.js";

/** First 64 bytes of a file ffmpeg wrote, base64. */
const HEADS = {
  png: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR4nA==",
  jpeg: "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBg==",
  webp: "UklGRkwAAABXRUJQVlA4IEAAAABQAwCdASogACAAPpFCnEolo6KhqAgAsBIJZQDGqoAAQFEcAAD+7tPf/uOwNw==",
  mp4: "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAABCNtZGF0AAACrgYF//+q3EXpvebZSA==",
  webmVideo:
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAPsEU2bdLpNu4tTq4QVSalmUw==",
  mov: "AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAABCNtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNg==",
  mp3: "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/+0DAAAAAAAAAAAAAAAAAAAAAAA==",
  wav: "UklGRs5YAQBXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAATElTVBoAAABJTkZPSVNGVA0AAABMYXZmNjEuNw==",
  m4a: "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAjNW1kYXTeAgBMYXZjNjEuMTkuMTAxAAJgrA==",
  webmAudio:
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAACcLEU2bdLpNu4tTq4QVSalmUw==",
} as const;

/**
 * Decode one sample into the bytes a reader would meet.
 * @param key - Which sample.
 * @returns Its leading bytes.
 */
function head(key: keyof typeof HEADS): Uint8Array {
  return Uint8Array.from(atob(HEADS[key]), (c) => c.charCodeAt(0));
}

describe("sniffMimeType — bytes a real encoder wrote", () => {
  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
    ["mp4", "video/mp4"],
    ["mov", "video/quicktime"],
    ["mp3", "audio/mpeg"],
    ["wav", "audio/wav"],
    ["webmVideo", "video/webm"],
  ] as const)("reads %s as %s", async (key, expected) => {
    expect(await sniffMimeType(head(key))).toBe(expected);
  });

  it("reads an m4a under the registry's other name for it", async () => {
    // What the bytes say is `audio/x-m4a`; what our list is written in is
    // `audio/mp4`. The gate below is what makes them one answer.
    expect(await sniffMimeType(head("m4a"))).toBe("audio/x-m4a");
  });

  it("cannot tell an audio-only webm from a video one", async () => {
    // Same container, same magic. This is why the edge asks the probe report
    // whether a real video stream is in there rather than trusting this.
    expect(await sniffMimeType(head("webmAudio"))).toBe("video/webm");
    expect(await sniffMimeType(head("webmVideo"))).toBe("video/webm");
  });
});

describe("what was sniffed passes the gates", () => {
  it.each(Object.keys(HEADS) as (keyof typeof HEADS)[])(
    "takes %s under whichever name the bytes gave",
    async (key) => {
      const sniffed = await sniffMimeType(head(key));
      expect(isUploadableMediaType(sniffed)).toBe(true);
      expect(isStorableMediaType(sniffed)).toBe(true);
    },
  );
});
