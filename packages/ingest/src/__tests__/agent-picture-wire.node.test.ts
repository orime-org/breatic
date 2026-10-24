// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { buildProbeAnswer, readProbeAnswer, type ProbeRequest } from "@ingest/probe-answer.js";
import { readMediaAtEdge, type MediaEnv } from "@ingest/media-read.js";
import { agentPictureArgs, previewArgs } from "@ingest/probe-command.js";

const SPEC = { version: 1 as const, longEdge: 1024, quality: 85 };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 5]);
const REPORT = { streams: [], durationSeconds: null };

describe("agent JPEG multipart agreement", () => {
  it("round-trips a distinct JPEG beside an independent WebP preview", async () => {
    const response = buildProbeAnswer(REPORT, null, WEBP, null, null, JPEG);
    const form = await response.clone().formData();
    const part = form.get("agentPicture");
    expect(part).toBeInstanceOf(File);
    expect((part as File).type).toBe("image/jpeg");
    expect((part as File).name).toMatch(/\.jpg$/);

    const read = await readProbeAnswer(response);
    expect(read.agentPicture).toEqual(JPEG);
    expect(read.preview).toEqual(WEBP);
    expect(read.answered).toBe(true);
  });

  it("keeps old container responses readable without synthesizing a picture", async () => {
    const read = await readProbeAnswer(buildProbeAnswer(REPORT, null));
    expect(read.agentPicture).toBeNull();
    expect(read.report).toEqual(REPORT);
    expect(read.answered).toBe(true);
  });

  it("refuses a part that declares another media type", async () => {
    const form = new FormData();
    form.set("meta", JSON.stringify(REPORT));
    form.set("agentPicture", new File([WEBP], "wrong.png", { type: "image/png" }));
    expect((await readProbeAnswer(new Response(form))).agentPicture).toBeNull();
  });

  it("does not treat an empty JPEG part as a generated picture", async () => {
    const form = new FormData();
    form.set("meta", JSON.stringify(REPORT));
    form.set("agentPicture", new File([], "empty.jpg", { type: "image/jpeg" }));
    expect((await readProbeAnswer(new Response(form))).agentPicture).toBeNull();
  });

  it("returns no picture when the answer has no usable metadata", async () => {
    const form = new FormData();
    form.set("meta", "not json");
    form.set("agentPicture", new File([JPEG], "picture.jpg", { type: "image/jpeg" }));
    const read = await readProbeAnswer(new Response(form));
    expect(read.agentPicture).toBeNull();
    expect(read.answered).toBe(false);
  });
});

describe("the agent picture request crossing the edge/container boundary", () => {
  it("passes the full specification and original task deadline to the authorized source reader", async () => {
    const asked: ProbeRequest[] = [];
    const authorised: string[] = [];
    const media = {
      idFromName: (name: string) => name,
      get: () => ({
        setOutboundByHost: (_host: string, _handler: string, params: { key: string }): Promise<void> => {
          authorised.push(params.key);
          return Promise.resolve();
        },
        fetch: async (request: Request): Promise<Response> => {
          asked.push(await request.json<ProbeRequest>());
          return buildProbeAnswer(REPORT, null, null, null, null, JPEG);
        },
      }),
    } as unknown as MediaEnv["MEDIA"];
    const deadlineAt = Date.now() + 7_200_000;

    const result = await readMediaAtEdge({ MEDIA: media, BUCKET: undefined as unknown as R2Bucket }, {
      storageKey: "image/registered.bin",
      contentType: "image/png",
      wantCover: false,
      agentPicture: SPEC,
      deadlineAt,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ agentPicture: SPEC, deadlineAt, wantCover: false });
    expect(authorised).toEqual(["image/registered.bin"]);
    expect(result.agentPicture).toEqual(JPEG);
  });
});

describe("the v1 JPEG command", () => {
  it("fits both edges, only shrinks and uses the requested JPEG quality", () => {
    const args = agentPictureArgs(SPEC);
    expect(args[0]).toBe("thumbnail_source");
    expect(args[1]).toBe("[descriptor=0]");
    expect(args[2]).toMatch(/^\.jpg\[.*Q=85(?:,|\])/);
    expect(args[3]).toBe("1024");
    expect(args[args.indexOf("--height") + 1]).toBe("1024");
    expect(args[args.indexOf("--size") + 1]).toBe("down");
  });

  it("normalizes to sRGB with white alpha and keeps automatic EXIF orientation", () => {
    const args = agentPictureArgs(SPEC);
    expect(args[args.indexOf("--output-profile") + 1]).toBe("srgb");
    expect(args[2]).toContain("background=255");
    expect(args[2]).toContain("keep=none");
    expect(args).not.toContain("--no-rotate");
  });

  it("uses configurable edges and quality while leaving the display preview independent", () => {
    const args = agentPictureArgs({ version: 1, longEdge: 768, quality: 90 });
    expect(args[2]).toMatch(/^\.jpg\[.*Q=90(?:,|\])/);
    expect(args[3]).toBe("768");
    expect(args[args.indexOf("--height") + 1]).toBe("768");
    expect(previewArgs()[2]).toBe(".webp[Q=80,keep=icc]");
    expect(previewArgs()[3]).toBe("576");
  });
});
