// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The transition window renderer of the MiniToolContainerGl image (frames-split design §5.4 dispatch row, §7.17
 * transition_window row; transitions render DD of 2026-11-05).
 *
 * A separate program, as the analysis runtime is: the container's service loads only Node built-ins and this
 * repository's code, while this process loads headless-gl (`gl`, a native module) and `gl-transition`, installed beside
 * it in /app/gl-renderer by the gl variant of packages/ingest/Dockerfile at the versions web pins. It draws each frame with the same
 * call the preview makes (packages/web/src/spaces/canvas/mini-tool/video/VideoTimelinePreview.tsx): a WebGL 1 context
 * `{ alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true }`, a full-screen triangle, LINEAR/CLAMP
 * textures, `createTransition(gl, { glsl, paramsTypes: {}, defaultParams: {} }, { resizeMode: 'contain' })` and the
 * `gl-transitions` shader of the type. The preview uploads canvases with UNPACK_FLIP_Y_WEBGL; here rows are flipped by
 * hand, which gives the same texel layout.
 *
 * Usage: node render.mjs <request.json>, the request being
 * `{ width, height, frameCount, transition, from, to, output, progress: number[] }`: two raw RGBA files of frameCount
 * frames each, and the RGBA file to write, one frame per progress value. Needs an X display (Xvfb).
 */

import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import createTransition from "gl-transition";

const TRANSITIONS = new Set(["fade", "wipeLeft", "wipeRight"]);

/**
 * Create one LINEAR/CLAMP texture as the preview does.
 * @param {WebGLRenderingContext} gl - The context.
 * @returns {{ texture: WebGLTexture; shape: [number, number]; bind: (unit: number) => number }} The texture as gl-transition reads it.
 */
function texture(gl) {
  const handle = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture: handle, shape: [1, 1], bind(unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, handle); return unit; } };
}

/**
 * Copy RGBA rows upside down.
 * @param {Uint8Array} source - The rows.
 * @param {Uint8Array} target - Where they go.
 * @param {number} width - The row width in pixels.
 * @param {number} height - The row count.
 * @returns {void}
 */
function flipRows(source, target, width, height) {
  const row = width * 4;
  for (let y = 0; y < height; y += 1) target.set(source.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
}

/**
 * Read one request, render every frame and write them.
 * @returns {void}
 * @throws {Error} When the request, a file, the context or a draw fails.
 */
function main() {
  if (process.argv.length !== 3) throw new Error("Expected exactly one request file path");
  const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { width, height, frameCount, transition, from, to, output, progress } = request;
  if (![width, height, frameCount].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Expected positive integral geometry and frame count");
  if (!TRANSITIONS.has(transition)) throw new Error(`Unsupported transition ${String(transition)}`);
  if (!Array.isArray(progress) || progress.length !== frameCount || !progress.every((value) => Number.isFinite(value))) throw new Error("Expected one progress per frame");
  const require = createRequire(import.meta.url);
  const createContext = require("gl");
  const glsl = readFileSync(new URL(`./node_modules/gl-transitions/transitions/${transition}.glsl`, import.meta.url), "utf8");
  const gl = createContext(width, height, { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (gl === null) throw new Error("No WebGL context");
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 4, 4, -1]), gl.STATIC_DRAW);
  gl.viewport(0, 0, width, height);
  const textures = [texture(gl), texture(gl)];
  const renderer = createTransition(gl, { glsl, paramsTypes: {}, defaultParams: {} }, { resizeMode: "contain" });
  const size = width * height * 4;
  const frames = [new Uint8Array(size), new Uint8Array(size)];
  const upload = new Uint8Array(size);
  const pixels = new Uint8Array(size);
  const out = new Uint8Array(size);
  const inputs = [openSync(from, "r"), openSync(to, "r")];
  const written = openSync(output, "w");
  try {
    for (let frame = 0; frame < frameCount; frame += 1) {
      inputs.forEach((file, at) => {
        if (readSync(file, frames[at], 0, size, frame * size) !== size) throw new Error(`Incomplete RGBA frame ${frame} of input ${at}`);
        flipRows(frames[at], upload, width, height);
        gl.bindTexture(gl.TEXTURE_2D, textures[at].texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, upload);
        textures[at].shape = [width, height];
      });
      renderer.draw(progress[frame], textures[0], textures[1], width, height, {});
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const error = gl.getError();
      if (error !== 0) throw new Error(`GL error ${error}`);
      flipRows(pixels, out, width, height);
      writeSync(written, out);
    }
  } finally {
    for (const file of [...inputs, written]) closeSync(file);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`gl renderer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
