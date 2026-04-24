/**
 * Image flip / rotate handler — Sharp-based.
 *
 * Applies one of four orientation transforms via Sharp's native
 * `.rotate()` / `.flip()` / `.flop()`. Same op vocabulary as the
 * pre-migration front-end helper
 * (`bitmapTransformToPngDataUrl` in `FlipRotateBottomToolbar.tsx`):
 *
 *   op: 'rotateMinus90' | 'rotate90' | 'flipHorizontal' | 'flipVertical'
 *
 * Output is PNG (preserves alpha if source had any).
 */

import sharp from "sharp";
import type { LocalHandlerFn, LocalHandlerResult } from "../index.js";
import { uploadBufferToStorage } from "../runtime/upload.js";

export type FlipRotateOp = "rotateMinus90" | "rotate90" | "flipHorizontal" | "flipVertical";

interface FlipRotateParams {
  image: string;
  op: FlipRotateOp;
}

function parseParams(raw: Record<string, unknown>): FlipRotateParams {
  const image = raw.image;
  const op = raw.op;
  if (typeof image !== "string" || !/^https?:\/\//i.test(image)) {
    throw new Error("image/flipRotate: `image` must be an http(s) URL");
  }
  if (op !== "rotateMinus90" && op !== "rotate90" && op !== "flipHorizontal" && op !== "flipVertical") {
    throw new Error(
      `image/flipRotate: \`op\` must be one of rotate90 / rotateMinus90 / flipHorizontal / flipVertical (got ${String(op)})`,
    );
  }
  return { image, op };
}

function applyOp(pipeline: sharp.Sharp, op: FlipRotateOp): sharp.Sharp {
  switch (op) {
    case "rotate90":
      return pipeline.rotate(90);
    case "rotateMinus90":
      return pipeline.rotate(-90);
    case "flipHorizontal":
      // Sharp: `.flop()` mirrors on X axis (horizontal flip).
      return pipeline.flop();
    case "flipVertical":
      // Sharp: `.flip()` mirrors on Y axis (vertical flip).
      return pipeline.flip();
  }
}

const handler: LocalHandlerFn = async (rawParams, ctx): Promise<LocalHandlerResult> => {
  const { image, op } = parseParams(rawParams);

  const response = await fetch(image);
  if (!response.ok) {
    throw new Error(`image/flipRotate: download failed (HTTP ${response.status}) for ${image}`);
  }
  const sourceBuffer = Buffer.from(await response.arrayBuffer());

  const outputBuffer = await applyOp(sharp(sourceBuffer), op).png().toBuffer();

  const url = await uploadBufferToStorage({
    buffer: outputBuffer,
    userId: ctx.userId,
    projectId: ctx.projectId,
    taskType: ctx.taskType,
    ext: ".png",
    contentType: "image/png",
  });

  return { url, cost: 0 };
};

export default handler;
