// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a backend upload declares about itself (#181, lanes ② and ③).
 *
 * Everything the ingest Worker's report will know comes from here. The Worker
 * fetched a link or received parts and can prove nothing about what they are,
 * so the grant and the ticket carry the whole story: which studio owns it,
 * what the asset is, which generation produced it, and how many parts the
 * transfer is allowed to reach.
 *
 * Where the two lanes differ is the size. Lane ② is holding the bytes and can
 * state their length; lane ③ has a link, which says nothing, so the configured
 * maximum travels as the ceiling the Worker holds the transfer to.
 *
 * Nothing real is reached — the grant, the ticket and both transports are
 * mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const issueUploadGrant = vi.fn();
const signUploadTicket = vi.fn();
const sendBytesToIngest = vi.fn();
const finishUploadAtIngest = vi.fn();
const fetchUrlToIngest = vi.fn();
const applyIngestReport = vi.fn();

const PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

vi.mock("@breatic/core", () => ({
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.example" },
  getStorageConfig: () => ({
    ingest: {
      part_size_bytes: PART_SIZE,
      ticket_expires_seconds: 900,
      session_token_ttl_seconds: 300,
    },
    upload: {
      max_upload_bytes: MAX_UPLOAD,
      client_max_attempts: 3,
      client_retry_base_delay_ms: 500,
      client_request_timeout_ms: 60_000,
      client_put_min_bytes_per_sec: 1024,
    },
  }),
}));
vi.mock("@breatic/shared", () => ({
  signUploadTicket,
  sendBytesToIngest,
  finishUploadAtIngest,
  fetchUrlToIngest,
}));
vi.mock("@domain/asset/upload-grant.service.js", () => ({ issueUploadGrant }));
vi.mock("@domain/asset/ingest-report.service.js", () => ({ applyIngestReport }));

const { uploadBytesToStorage, transferUrlToStorage } = await import(
  "@domain/asset/backend-upload.service.js"
);

/** What the Worker answers with once the object has landed. */
const MEASURED = {
  sha256: "a".repeat(64),
  sizeBytes: 1024,
  contentType: "image/png",
};

const CTX = {
  projectId: "p1",
  actingUserId: "u1",
  assetSource: "ai" as const,
  generationTaskId: "t1",
  taskType: "image",
  ext: ".png",
  contentType: "image/png",
};

beforeEach(() => {
  vi.clearAllMocks();
  issueUploadGrant.mockResolvedValue({ key: "image/2026-01-01/k.png", studioId: "s1" });
  signUploadTicket.mockResolvedValue("signed-ticket");
  sendBytesToIngest.mockResolvedValue({
    uploadId: "upload-1",
    token: "token-1",
    parts: [{ partNumber: 1, etag: "etag-1" }],
  });
  finishUploadAtIngest.mockResolvedValue(MEASURED);
  fetchUrlToIngest.mockResolvedValue(MEASURED);
  applyIngestReport.mockResolvedValue({
    status: "registered",
    assetId: "a1",
    fileUrl: "https://our-bucket/k.png",
    kind: "image",
  });
});

describe("uploadBytesToStorage — lane ②", () => {
  it("declares the bytes it is holding, and signs a ticket for the minted key", async () => {
    const bytes = new Blob([Buffer.alloc(1024, 7)]);

    const out = await uploadBytesToStorage(bytes, CTX);

    expect(issueUploadGrant).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: "p1",
        actingUserId: "u1",
        // The real length: these bytes are at hand, so nothing has to be
        // guessed at, and the grant is what the report is checked against.
        declaredSize: 1024,
        taskType: "image",
        ext: ".png",
        context: {
          assetSource: "ai",
          generationTaskId: "t1",
          // The worker announces the generation itself; a second activity row
          // written by the report handler would report one act twice.
          derived: true,
        },
      }),
    );
    expect(signUploadTicket).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        storageKey: "image/2026-01-01/k.png",
        // Ownership is decided where the caller's access to the project is
        // known, never asked of the Worker's report.
        studioId: "s1",
        userId: "u1",
        totalParts: 1,
        partSize: PART_SIZE,
        contentType: "image/png",
      }),
      "secret",
    );
    // Registration is what produces this, and it is what the caller pins.
    expect(out.fileUrl).toBe("https://our-bucket/k.png");
  });

  it("sends those exact bytes to the ingest Worker", async () => {
    const bytes = new Blob([Buffer.from("gen-bytes")]);

    await uploadBytesToStorage(bytes, CTX);

    const [blob, target] = sendBytesToIngest.mock.calls[0] as [Blob, { ticket: string }];
    // The very Blob it was handed: a caller whose bytes are on disk hands over
    // a file-backed one, and re-wrapping it here would read the whole file.
    expect(blob).toBe(bytes);
    expect(target).toMatchObject({
      ticket: "signed-ticket",
      uploadUrl: "https://ingest.example",
      partSize: PART_SIZE,
      totalParts: 1,
    });
  });

  it("counts the parts a large output needs", async () => {
    // A single part is exempt from R2's 5 MiB floor, which is why anything
    // under one part travels as one rather than being padded up; past that the
    // count has to cover the whole output or the last bytes have nowhere to go.
    await uploadBytesToStorage(new Blob([Buffer.alloc(PART_SIZE + 1)]), CTX);

    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({ totalParts: 2 });
  });

  it("still asks for one part when there is nothing to send", async () => {
    // R2 will not assemble an upload with no parts, so a ticket for zero of
    // them is refused before the emptiness itself can be reported — and the
    // report is where an empty product is turned into a failed, uncharged run.
    await uploadBytesToStorage(new Blob([]), CTX);

    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({ totalParts: 1 });
  });

  it("fails the upload when the report filed nothing", async () => {
    // Registering is what produces the url, so an answer without one means the
    // asset was never filed. A backend lane has no second channel to be told
    // that on: whatever it returns is what a node will point at.
    applyIngestReport.mockResolvedValue({ status: "voided" });

    await expect(uploadBytesToStorage(new Blob([]), CTX)).rejects.toThrow(
      /came back with no url/,
    );
  });

  it("names no generation when none produced the bytes", async () => {
    // A cover lifted from a user's own upload has no generation behind it.
    // Naming one anyway would file the asset against a task that did not
    // produce it, and that row is what a support question is answered from.
    await uploadBytesToStorage(new Blob([Buffer.alloc(16)]), {
      ...CTX,
      assetSource: "cover",
      generationTaskId: undefined,
    });

    const { context } = issueUploadGrant.mock.calls[0]?.[0] as {
      context: Record<string, unknown>;
    };
    expect(context.generationTaskId).toBeUndefined();
    expect(context).toMatchObject({ assetSource: "cover", derived: true });
  });
});

describe("transferUrlToStorage — lane ③", () => {
  it("declares the configured maximum as the ceiling, since a link says nothing", async () => {
    const out = await transferUrlToStorage("https://provider.example/tmp/out.png", CTX);

    expect(issueUploadGrant.mock.calls[0]?.[0]).toMatchObject({
      declaredSize: MAX_UPLOAD,
    });
    // The same number as parts: it is what the Worker holds the transfer to,
    // so a source that keeps serving cannot run past what was granted.
    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({
      totalParts: Math.ceil(MAX_UPLOAD / PART_SIZE),
      contentType: "image/png",
    });
    // The bytes never reach this process: the Worker is handed the link.
    expect(fetchUrlToIngest).toHaveBeenCalledExactlyOnceWith(
      "https://provider.example/tmp/out.png",
      expect.objectContaining({ ticket: "signed-ticket" }),
      "secret",
    );
    expect(sendBytesToIngest).not.toHaveBeenCalled();
    expect(out.fileUrl).toBe("https://our-bucket/k.png");
  });
});
