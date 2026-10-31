// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bring a picture found elsewhere into our storage (inner#1315).
 *
 * A proposal carries only material in our storage, and a picture the model
 * found is on somebody else's server. Saving it is the model's call to make,
 * so it is a tool of its own; the proposal check only says when an address is
 * not ours yet. The storing itself needs the project, the reader and the
 * server's gates, so the server hands it in through the tool's context.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import { FAILURE_LINES, type FailureLine } from "@breatic/shared";
import { readerUrlSchema } from "@domain/asset/source-url.js";
import { isStop, stoppedByUser, toolFailed, turnedAway } from "@domain/agent/tools/failure.js";
import { PROPOSE_CANVAS_ACTION } from "@domain/agent/tools/tool-names.js";

/** A saved picture, as the model reads it back. */
export interface SavedMaterial {
  /** Its address in our storage. */
  url: string;
  /** What the stored bytes are, as the ledger judged them. */
  mimeType: string;
  width: number | null;
  height: number | null;
}

/** Why a save did not happen, as far as the model needs to know. */
export type SaveRefusalKind = "link" | "rate_limited" | "storage_full" | "no_access";

/** A save the server refused, and why. */
export class SaveRefused extends Error {
  /**
   * A refusal of one kind.
   * @param kind - Which gate refused it.
   * @param detail - For a link, the reason its transfer was settled with.
   * @throws {never} Never.
   */
  constructor(
    readonly kind: SaveRefusalKind,
    readonly detail?: string,
  ) {
    super(`the save was refused: ${kind}${detail ? ` (${detail})` : ""}`);
    this.name = "SaveRefused";
  }
}

/** How the server stores a link for this turn's project and reader. */
export type SaveToStorage = (url: string, signal?: AbortSignal) => Promise<SavedMaterial>;

/** What this tool is handed in its context. */
export interface SaveContext extends Record<string, unknown> {
  saveToStorage: SaveToStorage;
}

const saveContextSchema: z.ZodType<SaveContext> = z.object({
  saveToStorage: z.custom<SaveToStorage>((value) => typeof value === "function", "a save function"),
});

const inputSchema = z.object({
  url: readerUrlSchema.describe("The https address of the picture to save, as it was found."),
});

/** The reader's cause for each reason a link could not be saved. */
const LINK_LINES: Readonly<Record<string, FailureLine>> = {
  source_unreachable: FAILURE_LINES.linkUnreachable,
  unsupported_type: FAILURE_LINES.unsupportedType,
  over_cap: FAILURE_LINES.fileTooLarge,
  empty: FAILURE_LINES.emptyFile,
};

/**
 * The failure the model and the reader are told for one refusal.
 * @param refused - What the server refused.
 * @returns The error to throw from `execute`.
 * @throws {never} Never.
 */
function refusalFailure(refused: SaveRefused): Error {
  switch (refused.kind) {
    case "link":
      return toolFailed(
        `The picture at that address could not be saved (${refused.detail ?? "no reason given"}). ` +
          "Pick another picture rather than trying this address again.",
        LINK_LINES[refused.detail ?? ""] ?? FAILURE_LINES.ourFault,
      );
    case "rate_limited":
      return toolFailed(
        "Too many links were fetched into storage in a short time (saves and links pasted on the canvas count " +
          "together). Wait a minute before saving another.",
        FAILURE_LINES.tooFrequent,
      );
    case "storage_full":
      return toolFailed(
        "The studio has no storage left, so nothing can be saved. Tell the user, and do not try again.",
        FAILURE_LINES.storageFull,
      );
    case "no_access":
      return toolFailed(
        "The user cannot add material to this project. Tell the user, and do not try again.",
        FAILURE_LINES.noPermission,
      );
  }
}

/**
 * The save tool, as a turn receives it.
 *
 * A fresh one per turn, for the same reason as `understand_media`: the model
 * can send several calls in one step, and one picture at a time is what keeps
 * a step from holding several transfers at once. A call that arrives while one
 * is saving is turned away, naming what to wait for.
 * @returns The tool.
 * @throws {Error} From `execute`, a failure the model reads.
 */
export function makeSaveImageTool(): Tool<z.infer<typeof inputSchema>, SavedMaterial, SaveContext> {
  let running = false;

  return tool({
    description:
      "Save a picture found on the web into the user's storage, so a node can hold it. " +
      `Nodes in ${PROPOSE_CANVAS_ACTION} only take material from our storage, so save a found ` +
      "picture first and use the address this answers with. Save one picture at a time, and " +
      "wait for the answer before saving the next.",
    inputSchema,
    contextSchema: saveContextSchema,
    metadata: { runningLine: "chat.tool.savingImage" },
    execute: async (
      { url },
      { abortSignal, context }: { abortSignal?: AbortSignal; context: SaveContext },
    ): Promise<SavedMaterial> => {
      if (running) {
        // Past tense: this sentence is stored on the call and read again by
        // every later turn, when nothing is saving any more.
        throw turnedAway(
          "Another picture was already being saved when this one arrived. Read that answer, " +
            "then save this one.",
        );
      }
      running = true;

      let saved;
      try {
        saved = await context.saveToStorage(url, abortSignal);
      } catch (err) {
        if (isStop(err, abortSignal)) throw stoppedByUser();
        if (err instanceof SaveRefused) throw refusalFailure(err);
        throw toolFailed(
          "Saving the picture failed on our side. Trying once more may work.",
          FAILURE_LINES.ourFault,
          err,
        );
      } finally {
        running = false;
      }

      if (!saved.mimeType.startsWith("image/")) {
        throw toolFailed(
          `That address holds ${saved.mimeType}, not a picture. Save only addresses of pictures.`,
          FAILURE_LINES.unsupportedType,
        );
      }
      return saved;
    },
  });
}
