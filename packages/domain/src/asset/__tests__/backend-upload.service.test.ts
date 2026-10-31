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
 * Lane ② no longer hands the ticket to the parts sender: the upload is opened
 * by `openSignedUpload` with the shared secret first (inner#1595), and the
 * parts go to that opened upload. Lane ③ still hands the ticket to the Worker,
 * which opens the upload inside its own fetch.
 *
 * Nothing real is reached — the grant, the ticket and both transports are
 * mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type * as IngestReportModule from "@domain/asset/ingest-report.service.js";

const issueUploadGrant = vi.fn();
const signUploadTicket = vi.fn();
const openUploadAtIngest = vi.fn();
const sendBytesToIngest = vi.fn();
const finishUploadAtIngest = vi.fn();
const fetchUrlToIngest = vi.fn();
const applyIngestReport = vi.fn();

const PART_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const IDLE_SECONDS = 45;
/** When the generation these bytes belong to runs out. */
const DEADLINE_AT = Date.now() + 3_600_000;
/** What core's idle-socket dispatcher hands back, as this test sees it. */
const IDLE_DISPATCHER = { dispatcher: "idle-socket" };
const idleSocketDispatcher = vi.fn(() => IDLE_DISPATCHER);

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.example" },
  budgetDeadlineFrom: (startedAt: number) => startedAt + 7_200_000,
  // Shaped like the real one, which the cover key is checked against below.
  storageKey: ({ taskType, ext }: { taskType: string; ext: string }) =>
    `${taskType}/2026-01-01/1_uuid${ext}`,
  coverKeyFor: (objectKey: string) =>
    `${objectKey.slice(0, objectKey.lastIndexOf("."))}_cover.png`,
  getStorageConfig: () => ({
    ingest: {
      part_size_bytes: PART_SIZE,
      ticket_expires_seconds: 900,
      upright_jpeg_quality: 85,
    },
    upload: {
      max_upload_bytes: MAX_UPLOAD,
      client_max_attempts: 3,
      client_retry_base_delay_ms: 500,
      upload_idle_timeout_seconds: IDLE_SECONDS,
    },
  }),
  idleSocketDispatcher,
}));
// Real but for the five calls driven here, so the rule deciding which media
// has a frame to cut is the shared one rather than a copy typed in a test.
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  signUploadTicket,
  openUploadAtIngest,
  sendBytesToIngest,
  finishUploadAtIngest,
  fetchUrlToIngest,
}));
vi.mock("@domain/asset/upload-grant.service.js", () => ({ issueUploadGrant }));
vi.mock("@domain/asset/ingest-report.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyIngestReport,
}));

const { uploadBytesToStorage, transferUrlToStorage, transferReaderUrlToStorage, ReaderUrlTransferError } =
  await import("@domain/asset/backend-upload.service.js");
const { DeadlinePassed, INGEST_NO_ANSWER, INGEST_REFUSED_UNNAMED, INGEST_TYPE_NOT_REPORTED, UploadHttpError } =
  await import("@breatic/shared");
const { UploadOpenFailed } = await import("@domain/asset/upload-open-failure.js");

/** The target the upload was opened with, as the last open saw it. */
type OpeningTarget = { ticket: string; uploadUrl: string; partSize: number; totalParts: number };

/**
 * The target the last open at the Worker was handed.
 * @returns It, or undefined when nothing was opened.
 */
function openingTarget(): OpeningTarget | undefined {
  return openUploadAtIngest.mock.calls.at(-1)?.[0] as OpeningTarget | undefined;
}

/**
 * The deadline the last signed ticket carries.
 * @returns It, in epoch ms.
 */
function signTicketDeadline(): number | undefined {
  return (signUploadTicket.mock.calls.at(-1)?.[0] as { deadlineAt?: number } | undefined)
    ?.deadlineAt;
}

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
  deadlineAt: DEADLINE_AT,
};

/** What every call of a backend upload is bounded by. */
const RUN = {
  deadlineAt: DEADLINE_AT,
  // What a tagged picture is turned upright under, off the mocked yaml.
  limits: { uprightJpegQuality: 85, uprightMaxBytes: MAX_UPLOAD },
};

beforeEach(() => {
  vi.clearAllMocks();
  issueUploadGrant.mockResolvedValue({ key: "image/2026-01-01/k.png", studioId: "s1" });
  signUploadTicket.mockResolvedValue("signed-ticket");
  openUploadAtIngest.mockResolvedValue({ uploadId: "upload-1", token: "token-1" });
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
    // T47: the signed ticket is what the upload is opened with.
    expect(openingTarget()).toMatchObject({ ticket: "signed-ticket", totalParts: 1 });
    // Registration is what produces this, and it is what the caller pins.
    expect(out.fileUrl).toBe("https://our-bucket/k.png");
  });

  it("sends those exact bytes to the ingest Worker", async () => {
    const bytes = new Blob([Buffer.from("gen-bytes")]);

    await uploadBytesToStorage(bytes, CTX);

    const [blob, target] = sendBytesToIngest.mock.calls[0] as [Blob, Record<string, unknown>];
    // The very Blob it was handed: a caller whose bytes are on disk hands over
    // a file-backed one, and re-wrapping it here would read the whole file.
    expect(blob).toBe(bytes);
    // The ticket went to the open; the parts go to the upload it opened.
    expect(openingTarget()).toMatchObject({
      ticket: "signed-ticket",
      uploadUrl: "https://ingest.example",
      partSize: PART_SIZE,
      totalParts: 1,
    });
    expect(target).toMatchObject({
      uploadUrl: "https://ingest.example",
      uploadId: "upload-1",
      token: "token-1",
      partSize: PART_SIZE,
      totalParts: 1,
    });
    expect(target).not.toHaveProperty("ticket");
  });

  it("T43: opens the upload with the secret under the deadline, then sends the parts to it", async () => {
    const before = Date.now();

    await uploadBytesToStorage(new Blob([Buffer.alloc(1024, 7)]), CTX);

    expect(openUploadAtIngest).toHaveBeenCalledTimes(1);
    const [, secret, bound] = openUploadAtIngest.mock.calls[0] as [
      unknown,
      string,
      { signal?: AbortSignal; timeoutMs?: number },
    ];
    expect(secret).toBe("secret");
    // inner#1595 R1: a timeout alone; a deadline signal would outlive the open.
    expect(bound).not.toHaveProperty("signal");
    expect(bound.timeoutMs).toBeGreaterThan(0);
    expect(bound.timeoutMs).toBeLessThanOrEqual(DEADLINE_AT - before);

    expect(sendBytesToIngest).toHaveBeenCalledTimes(1);
    const target = sendBytesToIngest.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(target).toEqual({
      uploadUrl: "https://ingest.example",
      uploadId: "upload-1",
      token: "token-1",
      partSize: PART_SIZE,
      totalParts: 1,
      dispatcher: IDLE_DISPATCHER,
    });
    expect(Object.hasOwn(target, "ticket")).toBe(false);
    expect(openUploadAtIngest.mock.invocationCallOrder[0]).toBeLessThan(
      sendBytesToIngest.mock.invocationCallOrder[0] ?? 0,
    );
    expect(finishUploadAtIngest).toHaveBeenCalledTimes(1);
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ storageKey: "image/2026-01-01/k.png", outcome: "completed" }),
    );
  });

  it("T44: settles the grant and throws UploadOpenFailed when the Worker will not open", async () => {
    const refused = new UploadHttpError(502, "store_failed");
    const settled = { status: "voided" };
    openUploadAtIngest.mockRejectedValue(refused);
    applyIngestReport.mockResolvedValue(settled);

    const failed = await uploadBytesToStorage(new Blob(["x"]), CTX).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(UploadOpenFailed);
    const open = failed as InstanceType<typeof UploadOpenFailed>;
    expect(open.reason).toBe("store_failed");
    expect(open.settled).toBe(settled);
    expect(open.cause).toBe(refused);
    expect(sendBytesToIngest).not.toHaveBeenCalled();
    expect(finishUploadAtIngest).not.toHaveBeenCalled();
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: "image/2026-01-01/k.png",
      outcome: "aborted",
      reason: "store_failed",
    });
    expect(openUploadAtIngest).toHaveBeenCalledTimes(1);
  });

  it("T44: keeps the settling error itself when settling the unopened upload fails too", async () => {
    const unsettled = new Error("db down");
    openUploadAtIngest.mockRejectedValue(new UploadHttpError(502, "store_failed"));
    applyIngestReport.mockRejectedValue(unsettled);

    const failed = await uploadBytesToStorage(new Blob(["x"]), CTX).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(UploadOpenFailed);
    expect(failed).not.toBeInstanceOf(AggregateError);
    const open = failed as InstanceType<typeof UploadOpenFailed>;
    expect(open.settleError).toBe(unsettled);
    expect(open.settled).toBeUndefined();
    expect(sendBytesToIngest).not.toHaveBeenCalled();
  });

  // A part is cut once its bytes stop moving (inner#1367). Node judges that on
  // the socket, so the parts go through a dispatcher that times it, and every
  // call of the upload is bounded by the generation's deadline.
  it("sends the parts through an idle-timed socket, under the deadline", async () => {
    await uploadBytesToStorage(new Blob(["x"]), CTX);

    expect(idleSocketDispatcher).toHaveBeenCalledWith(IDLE_SECONDS * 1000);
    const [, target, knobs, onPartLanded, deadlineAt] = sendBytesToIngest.mock.calls[0] as [
      Blob,
      { dispatcher?: unknown },
      { uploadIdleTimeoutMs: number },
      unknown,
      number,
    ];
    expect(target.dispatcher).toBe(IDLE_DISPATCHER);
    expect(knobs.uploadIdleTimeoutMs).toBe(IDLE_SECONDS * 1000);
    expect(onPartLanded).toBeUndefined();
    expect(deadlineAt).toBe(DEADLINE_AT);
    expect(signTicketDeadline()).toBe(DEADLINE_AT);
  });

  it("starts nothing once the generation's deadline has passed", async () => {
    await expect(
      uploadBytesToStorage(new Blob(["x"]), { ...CTX, deadlineAt: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(DeadlinePassed);
    expect(issueUploadGrant).not.toHaveBeenCalled();
    // T45: nothing is opened at the Worker either.
    expect(openUploadAtIngest).not.toHaveBeenCalled();
  });

  it("counts the parts a large output needs", async () => {
    // A single part is exempt from R2's 5 MiB floor, which is why anything
    // under one part travels as one rather than being padded up; past that the
    // count has to cover the whole output or the last bytes have nowhere to go.
    await uploadBytesToStorage(new Blob([Buffer.alloc(PART_SIZE + 1)]), CTX);

    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({ totalParts: 2 });
    // T47: and that layout is the one the upload is opened with.
    expect(openingTarget()).toMatchObject({ totalParts: 2, partSize: PART_SIZE });
  });

  it("still asks for one part when there is nothing to send", async () => {
    // R2 will not assemble an upload with no parts, so a ticket for zero of
    // them is refused before the emptiness itself can be reported — and the
    // report is where an empty product is turned into a failed, uncharged run.
    await uploadBytesToStorage(new Blob([]), CTX);

    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({ totalParts: 1 });
    // T47: and that layout is the one the upload is opened with.
    expect(openingTarget()).toMatchObject({ totalParts: 1 });
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

// A backend lane has no node listening on Yjs, so whatever it hands back is
// the whole of what its caller can put on one. The numbers are on the ledger
// row either way; leaving them out of the answer is what left a generated
// node measuring its own media in the browser (A1).
describe("what a backend lane hands back", () => {
  it("carries the numbers the row was registered with", async () => {
    applyIngestReport.mockResolvedValue({
      status: "registered",
      assetId: "a1",
      fileUrl: "https://our-bucket/k.mp4",
      kind: "video",
      coverUrl: "https://our-bucket/k_cover.png",
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
    });

    const stored = await uploadBytesToStorage(new Blob(["x"]), CTX);

    expect(stored).toMatchObject({
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
    });
  });

  // Each flag is the only account of what went wrong beside the row; the
  // worker and the agent log what this hands back, so none may be dropped.
  it("carries every side-effect flag registration raised", async () => {
    const { INGEST_SIDE_EFFECT_EVENTS } = await vi.importActual<typeof IngestReportModule>(
      "@domain/asset/ingest-report.service.js",
    );
    const flags = Object.fromEntries(Object.keys(INGEST_SIDE_EFFECT_EVENTS).map((flag) => [flag, true]));
    expect(flags).toHaveProperty("peaksQueueFailed", true);
    applyIngestReport.mockResolvedValue({
      status: "registered",
      assetId: "a1",
      fileUrl: "https://our-bucket/k.mp3",
      kind: "audio",
      coverUrl: null,
      width: null,
      height: null,
      durationSeconds: 61,
      ...flags,
    });

    expect(await uploadBytesToStorage(new Blob(["x"]), CTX)).toMatchObject(flags);
    expect(await transferUrlToStorage("https://provider.example/out.mp3", CTX)).toMatchObject(flags);
  });

  it("says there are none when the row has none", async () => {
    applyIngestReport.mockResolvedValue({
      status: "registered",
      assetId: "a1",
      fileUrl: "https://our-bucket/k.txt",
      kind: "file",
      coverUrl: null,
      width: null,
      height: null,
      durationSeconds: null,
    });

    const stored = await uploadBytesToStorage(new Blob(["x"]), CTX);

    expect(stored).toMatchObject({
      width: null,
      height: null,
      durationSeconds: null,
    });
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
      // A place for a frame, named for every transfer: this lane learns what
      // it fetched only after the bytes are down, so there is nothing here to
      // narrow by and the edge narrows instead (#240).
      // The transfer and the container are held to the generation's own
      // deadline and nothing else (inner#1367).
      { coverKey: "image/2026-01-01/k_cover.png", ...RUN },
    );
    expect(sendBytesToIngest).not.toHaveBeenCalled();
    expect(out.fileUrl).toBe("https://our-bucket/k.png");
  });

  // T46: lane ③ hands the ticket to the Worker's fetch, which opens the
  // upload itself; nothing here opens one beforehand.
  it("T46: opens nothing ahead of a link transfer, and still hands the Worker the ticket", async () => {
    await transferUrlToStorage("https://provider.example/tmp/out.png", CTX);
    await transferReaderUrlToStorage("https://imgs.example/cat.jpg", { projectId: "p1", actingUserId: "u1" });

    expect(openUploadAtIngest).not.toHaveBeenCalled();
    expect(fetchUrlToIngest).toHaveBeenCalledTimes(2);
    for (const call of fetchUrlToIngest.mock.calls) {
      expect(call[1]).toMatchObject({ ticket: "signed-ticket" });
    }
  });

  // A generated video reaches R2 down this lane, and its cover has to come
  // out of the same container run — extracting it afterwards is what left a
  // generation's cover unlinked (#201).
  it("names a cover key beside the video it is cut from", async () => {
    issueUploadGrant.mockResolvedValue({
      key: "video/2026-01-01/k.mp4",
      studioId: "s1",
    });

    await transferUrlToStorage("https://provider.example/tmp/out.mp4", {
      ...CTX,
      taskType: "video",
      ext: ".mp4",
      contentType: "video/mp4",
    });

    expect(fetchUrlToIngest).toHaveBeenCalledExactlyOnceWith(
      "https://provider.example/tmp/out.mp4",
      expect.anything(),
      "secret",
      // Derived from the video's own key, so re-delivering this transfer
      // names the frame it already cut (A5).
      { coverKey: "video/2026-01-01/k_cover.png", ...RUN },
    );
  });
});

// Lane ② is what a mini-tool's ffmpeg output and a synchronous transport's
// bytes both take. Nothing asserted what it asks the Worker for, so dropping
// either argument left every asset down it without its numbers and every video
// without a cover, with the whole suite still green.
describe("what lane ② asks the Worker for", () => {
  it("names the cover key beside the video, and the windows for the run", async () => {
    issueUploadGrant.mockResolvedValue({
      key: "video/2026-01-01/k.mp4",
      studioId: "s1",
    });

    await uploadBytesToStorage(new Blob(["x"]), {
      ...CTX,
      taskType: "video",
      ext: ".mp4",
      contentType: "video/mp4",
    });

    expect(finishUploadAtIngest).toHaveBeenCalledExactlyOnceWith(
      "https://ingest.example",
      expect.anything(),
      "secret",
      { coverKey: "video/2026-01-01/k_cover.png", ...RUN },
    );
  });

  // Named for every upload, whatever this side thinks it is holding: nothing
  // here has seen a byte, and the edge narrows to what the stored object turns
  // out to be. A key nobody uses costs nothing; a key never named cannot be
  // handed over afterwards, because the run happens once (#240).
  it("names a place for a frame even for bytes it thinks have none", async () => {
    issueUploadGrant.mockResolvedValue({
      key: "image/2026-01-01/k.png",
      studioId: "s1",
    });

    await uploadBytesToStorage(new Blob(["x"]), CTX);

    expect(finishUploadAtIngest).toHaveBeenCalledExactlyOnceWith(
      "https://ingest.example",
      expect.anything(),
      "secret",
      { coverKey: "image/2026-01-01/k_cover.png", ...RUN },
    );
  });
});

// A link somebody other than a provider handed over: the agent's save
// (inner#1315). Nobody here knows what it holds, so the Worker reads the type
// off the source, and a refusal is the link's, settled before it is reported.
describe("transferReaderUrlToStorage — a reader's link (inner#1315)", () => {
  const LINK = "https://imgs.example/photos/cat.JPG?sig=abc";
  const WHO = { projectId: "p1", actingUserId: "u1" };

  it("opens an agent grant keyed by the link's extension and lets the Worker read the type", async () => {
    await transferReaderUrlToStorage(LINK, WHO);

    expect(issueUploadGrant.mock.calls[0]?.[0]).toMatchObject({
      projectId: "p1",
      actingUserId: "u1",
      declaredSize: MAX_UPLOAD,
      taskType: "url",
      ext: ".jpg",
      context: { assetSource: "agent", derived: true },
    });
    expect(signUploadTicket.mock.calls[0]?.[0]).toMatchObject({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });
  });

  it("hands the stop signal to the transfer", async () => {
    const stop = new AbortController();

    await transferReaderUrlToStorage(LINK, WHO, stop.signal);

    expect(fetchUrlToIngest.mock.calls[0]?.[4]).toBe(stop.signal);
  });

  // The grant it opens runs out two hours on, like any upload's, and the
  // transfer is held to that same moment.
  it("holds the transfer to the deadline its ticket carries", async () => {
    await transferReaderUrlToStorage(LINK, WHO);

    const deadlineAt = signTicketDeadline();
    expect(deadlineAt).toBeGreaterThan(Date.now() + 7_190_000);
    expect(fetchUrlToIngest.mock.calls[0]?.[3]).toMatchObject({ deadlineAt });
  });

  it("registers the type the Worker judged, not the placeholder it was signed with", async () => {
    fetchUrlToIngest.mockResolvedValue({ ...MEASURED, contentType: "image/jpeg; charset=binary" });

    const out = await transferReaderUrlToStorage(LINK, WHO);

    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "completed", contentType: "image/jpeg" }),
    );
    expect(out.fileUrl).toBe("https://our-bucket/k.png");
  });

  it("settles the grant and names the link's own refusal", async () => {
    fetchUrlToIngest.mockRejectedValue(new UploadHttpError(502, "source_unreachable"));

    const failed = await transferReaderUrlToStorage(LINK, WHO).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(ReaderUrlTransferError);
    expect((failed as InstanceType<typeof ReaderUrlTransferError>).reason).toBe("source_unreachable");
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: "image/2026-01-01/k.png",
      outcome: "aborted",
      reason: "source_unreachable",
    });
  });

  it("settles the grant when nothing answered", async () => {
    fetchUrlToIngest.mockRejectedValue(new Error("socket hang up"));

    const failed = await transferReaderUrlToStorage(LINK, WHO).catch((err: unknown) => err);

    expect((failed as InstanceType<typeof ReaderUrlTransferError>).reason).toBe(INGEST_NO_ANSWER);
    expect(applyIngestReport).toHaveBeenCalledWith(expect.objectContaining({ outcome: "aborted" }));
  });

  it("T34: settles the grant as the unnamed refusal when the Worker answered without a name", async () => {
    fetchUrlToIngest.mockRejectedValue(new UploadHttpError(500, null));

    const failed = await transferReaderUrlToStorage(LINK, WHO).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(ReaderUrlTransferError);
    expect((failed as InstanceType<typeof ReaderUrlTransferError>).reason).toBe(INGEST_REFUSED_UNNAMED);
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: "image/2026-01-01/k.png",
      outcome: "aborted",
      reason: INGEST_REFUSED_UNNAMED,
    });
  });

  it("settles the grant when the stored type is not one we take", async () => {
    fetchUrlToIngest.mockResolvedValue({ ...MEASURED, contentType: "application/octet-stream" });

    const failed = await transferReaderUrlToStorage(LINK, WHO).catch((err: unknown) => err);

    expect((failed as InstanceType<typeof ReaderUrlTransferError>).reason).toBe(INGEST_TYPE_NOT_REPORTED);
    expect((failed as InstanceType<typeof ReaderUrlTransferError>).reported).toBe("application/octet-stream");
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "aborted", reason: INGEST_TYPE_NOT_REPORTED }),
    );
  });

  it("keeps why the link failed when settling its grant fails too", async () => {
    const refused = new UploadHttpError(502, "source_unreachable");
    const unsettled = new Error("db down");
    fetchUrlToIngest.mockRejectedValue(refused);
    applyIngestReport.mockRejectedValue(unsettled);

    const failed = await transferReaderUrlToStorage(LINK, WHO).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(AggregateError);
    expect((failed as AggregateError).errors).toEqual([refused, unsettled]);
    expect((failed as AggregateError).message).toContain("source_unreachable");
  });

  it.each(["empty", "over_cap"])("names a %s report as the link's own refusal", async (reason) => {
    // The report turned down what the link sent: the link is at fault, and
    // the same link gets the same answer again.
    applyIngestReport.mockResolvedValue({ status: "rejected", reason });

    const failed = await transferReaderUrlToStorage(LINK, WHO).catch((err: unknown) => err);

    expect(failed).toBeInstanceOf(ReaderUrlTransferError);
    expect((failed as InstanceType<typeof ReaderUrlTransferError>).reason).toBe(reason);
  });
});
