// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The picture adjust's WebGL path against the ffmpeg fixture (inner#1303 A2).
 *
 * The unit suite runs every filter's 2D path; the preview and the export draw
 * through Fabric's WebGL backend and its shaders, which only a browser runs.
 * Each case goes through `drawAdjusted`, the entry the preview and the export
 * both call, with the tolerances the 2D tests hold (`adjust-ffmpeg.test.ts`).
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

const fixture: unknown = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/spaces/canvas/mini-tool/__tests__/fixtures/adjust-ffmpeg.json'), 'utf8'),
);

/** What the page measured, worst case per family. */
interface Report {
  webgl: boolean;
  colors: number;
  greyEdges: number;
  colourEdges: number;
  vignette: number;
  previewVignette: number;
  grains: { spread: number[]; corr: number[] }[];
  cutout: { worst: number; alpha: [number, number] }[];
  previewGrain: number[];
  previewNoise: number[];
}

test('the picture adjust draws through WebGL as ffmpeg does', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const report: Report = await page.evaluate(async (fx) => {
    // Page URLs the dev server serves, read from a variable so the type checker leaves them to the page.
    const exportModule = '/spaces/canvas/mini-tool/adjust-export.ts';
    const exporter = await import(exportModule);
    const text = await (await fetch('/spaces/canvas/mini-tool/adjust-filters.ts')).text();
    const fabric = await import(/from\s+"([^"]*\/fabric\.js[^"]*)"/.exec(text)?.[1] ?? '');
    const shared = await import(
      /from\s+"([^"]*@breatic_shared[^"]*|[^"]*shared\/dist\/index\.js[^"]*)"/.exec(text)?.[1] ?? ''
    );
    const defaults = shared.defaultAdjustValue;
    const f = fx as {
      colors: { value: object; pixels: Record<string, number[]> }[];
      edges: { value: object; left: string; right: string; row: number[][] }[];
      vignettes: { value: object; color: string; width: number; height: number; points: { x: number; y: number; rgb: number[] }[]; frame?: number[] }[];
      grains: { value: object; std: number[]; corr: { rg: number; rb: number; gb: number } }[];
    };
    const hex = (c: string): number[] => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
    // A picture painted at the source's size, drawn at w×h.
    const run = async (
      w: number,
      h: number,
      paint: (x: number, y: number) => number[],
      value: object,
      source = { width: w, height: h },
    ): Promise<ImageData> => {
      const el = document.createElement('canvas');
      el.width = source.width;
      el.height = source.height;
      const ctx = el.getContext('2d')!;
      const img = ctx.createImageData(source.width, source.height);
      for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
          const p = paint(Math.floor((x * w) / source.width), Math.floor((y * h) / source.height));
          img.data.set(p.length === 4 ? p : [...p, 255], (y * source.width + x) * 4);
        }
      }
      ctx.putImageData(img, 0, 0);
      const blob: Blob = await new Promise((done) => el.toBlob((b) => done(b!), 'image/png'));
      const picture = new Image();
      picture.src = URL.createObjectURL(blob);
      await picture.decode();
      const out = document.createElement('canvas');
      await exporter.drawAdjusted(picture, { width: w, height: h }, { ...defaults, ...value }, out);
      return out.getContext('2d')!.getImageData(0, 0, w, h);
    };
    const gap = (a: number[], b: number[]): number => Math.max(...a.map((v, k) => Math.abs(v - (b[k] ?? 0))));
    const px = (d: ImageData, x: number, y: number): number[] =>
      Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 3));
    const sdOf = (d: ImageData, k: number): number => {
      const a = Array.from({ length: d.width * d.height }, (_, i) => d.data[i * 4 + k] ?? 0);
      const m = a.reduce((s, x) => s + x, 0) / a.length;
      return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
    };

    let colors = 0;
    for (const c of f.colors) {
      for (const [h, expected] of Object.entries(c.pixels)) {
        colors = Math.max(colors, gap(px(await run(16, 16, () => hex(h), c.value), 8, 8), expected));
      }
    }
    // ffmpeg's 4:2:0 frame averages pairs of columns, so the rows compare in pairs.
    const pair = (row: number[][]): number[][] =>
      Array.from({ length: 32 }, (_, p) => [0, 1, 2].map((k) => ((row[2 * p]?.[k] ?? 0) + (row[2 * p + 1]?.[k] ?? 0)) / 2));
    let greyEdges = 0;
    let colourEdges = 0;
    for (const e of f.edges) {
      const d = await run(64, 16, (x) => hex(x < 32 ? e.left : e.right), e.value);
      const ours = pair(Array.from({ length: 64 }, (_, x) => px(d, x, 8)));
      const theirs = pair(e.row);
      const worst = Math.max(...ours.map((rgb, p) => gap(rgb, theirs[p] ?? [])));
      if (e.left === '404040') greyEdges = Math.max(greyEdges, worst);
      else colourEdges = Math.max(colourEdges, worst);
    }
    let vignette = 0;
    for (const v of f.vignettes) {
      const d = await run(v.width, v.height, () => hex(v.color), v.value);
      for (const p of v.points) vignette = Math.max(vignette, gap(px(d, p.x, p.y), p.rgb));
      // A small frame at every pixel, as the 2D test holds it.
      for (let y = 0; v.frame !== undefined && y < v.height; y++) {
        for (let x = 0; x < v.width; x++) {
          vignette = Math.max(vignette, gap(px(d, x, y), v.frame.slice((y * v.width + x) * 3, (y * v.width + x) * 3 + 3)));
        }
      }
    }
    // The vignette drawn at half of a 128 source against the 1:1 result averaged 2×2.
    const fullVignette = await run(128, 128, () => [255, 255, 255], { vignette: 100 });
    const halfVignette = await run(64, 64, () => [255, 255, 255], { vignette: 100 }, { width: 128, height: 128 });
    let previewVignette = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const mean = [0, 1, 2].map(
          (k) =>
            [0, 1].reduce((s, j) => s + [0, 1].reduce((t, i) => t + (fullVignette.data[((y * 2 + j) * 128 + x * 2 + i) * 4 + k] ?? 0), 0), 0) / 4,
        );
        previewVignette = Math.max(previewVignette, gap(px(halfVignette, x, y), mean));
      }
    }
    // How two channels move together, as the 2D test measures it.
    const together = (d: ImageData, a: number, b: number): number => {
      const n = d.width * d.height;
      const ch = (k: number): number[] => Array.from({ length: n }, (_, i) => d.data[i * 4 + k] ?? 0);
      const [x, y] = [ch(a), ch(b)];
      const mx = x.reduce((s, v) => s + v, 0) / n;
      const my = y.reduce((s, v) => s + v, 0) / n;
      return x.reduce((s, v, i) => s + (v - mx) * ((y[i] ?? 0) - my), 0) / n / (sdOf(d, a) * sdOf(d, b));
    };
    const grains: { spread: number[]; corr: number[] }[] = [];
    for (const g of f.grains) {
      const d = await run(64, 64, () => [128, 128, 128], g.value);
      grains.push({
        spread: [0, 1, 2].map((k) => sdOf(d, k) / (g.std[k] ?? 1)),
        corr: [
          together(d, 0, 1) - g.corr.rg,
          together(d, 0, 2) - g.corr.rb,
          together(d, 1, 2) - g.corr.gb,
        ],
      });
    }
    // A cut-out: transparent left half, opaque right half, at 1:1 and drawn at 1/4.
    const cutout: { worst: number; alpha: [number, number] }[] = [];
    for (const shrink of [1, 4]) {
      for (const value of [{ noiseReduction: 100 }, { sharpness: 100 }, { clarity: 100 }]) {
        const d = await run(40, 8, (x) => (x < 20 ? [0, 0, 0, 0] : [200, 60, 40, 255]), value, {
          width: 40 * shrink,
          height: 8 * shrink,
        });
        const worst = Math.max(...Array.from({ length: 20 }, (_, i) => gap(px(d, 20 + i, 4), px(d, 32, 4))));
        cutout.push({ worst, alpha: [d.data[(4 * 40 + 20) * 4 + 3] ?? 0, d.data[(4 * 40 + 10) * 4 + 3] ?? 0] });
      }
    }
    // Grain drawn at 1/4 of a 128 source against the 1:1 result averaged 4×4.
    const big = await run(128, 128, () => [128, 128, 128], { grain: 100 });
    const avg = new ImageData(32, 32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        for (let k = 0; k < 4; k++) {
          let sum = 0;
          for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) sum += big.data[((y * 4 + j) * 128 + x * 4 + i) * 4 + k] ?? 0;
          avg.data[(y * 32 + x) * 4 + k] = sum / 16;
        }
      }
    }
    const small = await run(32, 32, () => [128, 128, 128], { grain: 100 }, { width: 128, height: 128 });
    const previewGrain = [0, 1, 2].map((k) => sdOf(small, k) / sdOf(avg, k));
    // Noise reduction drawn smaller than its source against the export shrunk
    // to that size by area: a colour edge carries no fringe the export lacks.
    const drawFrom = async (width: number, height: number, edge: number, colours: string[], value: object, w: number, h: number): Promise<ImageData> => {
      const el = document.createElement('canvas');
      el.width = width;
      el.height = height;
      const ctx = el.getContext('2d')!;
      ctx.fillStyle = `#${colours[0]}`;
      ctx.fillRect(0, 0, edge, height);
      ctx.fillStyle = `#${colours[1]}`;
      ctx.fillRect(edge, 0, width - edge, height);
      const blob: Blob = await new Promise((done) => el.toBlob((b) => done(b!), 'image/png'));
      const picture = new Image();
      picture.src = URL.createObjectURL(blob);
      await picture.decode();
      const out = document.createElement('canvas');
      await exporter.drawAdjusted(picture, { width: w, height: h }, { ...defaults, ...value }, out);
      return out.getContext('2d')!.getImageData(0, 0, w, h);
    };
    const shrink = (d: ImageData, w: number, h: number): number[][] => {
      const cover = (p: number, scale: number, n: number): [number, number][] => {
        const out: [number, number][] = [];
        for (let i = Math.floor(p * scale); i < (p + 1) * scale && i < n; i++) {
          const c = Math.min((p + 1) * scale, i + 1) - Math.max(p * scale, i);
          if (c > 1e-9) out.push([i, c]);
        }
        return out;
      };
      return Array.from({ length: w * h }, (_, n) => {
        const x = n % w;
        const y = Math.floor(n / w);
        let area = 0;
        const sum = [0, 0, 0];
        for (const [j, cy] of cover(y, d.height / h, d.height)) {
          for (const [i, cx] of cover(x, d.width / w, d.width)) {
            for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + cx * cy * (d.data[(j * d.width + i) * 4 + k] ?? 0);
            area += cx * cy;
          }
        }
        return sum.map((v) => v / area);
      });
    };
    const previewNoise: number[] = [];
    for (const [width, w, edge, colours] of [
      [128, 64, 63, ['0000FF', 'FFFF00']],
      [128, 64, 64, ['0000FF', 'FFFF00']],
      [1024, 576, 307, ['B2664C', '3366CC']],
    ] as const) {
      for (const noiseReduction of [10, 30, 100]) {
        const height = 16;
        const h = Math.round((height * w) / width);
        const value = { noiseReduction };
        const theirs = shrink(await drawFrom(width, height, edge, [...colours], value, width, height), w, h);
        const ours = await drawFrom(width, height, edge, [...colours], value, w, h);
        previewNoise.push(Math.max(...theirs.map((rgb, n) => gap(Array.from(ours.data.slice(n * 4, n * 4 + 3)), rgb))));
      }
    }
    return {
      webgl: 'tileSize' in fabric.getFilterBackend(),
      colors,
      greyEdges,
      colourEdges,
      vignette,
      previewVignette,
      grains,
      cutout,
      previewGrain,
      previewNoise,
    };
  }, fixture);

  expect(report.webgl).toBe(true);
  expect(report.colors).toBeLessThanOrEqual(5);
  expect(report.greyEdges).toBeLessThanOrEqual(8);
  expect(report.colourEdges).toBeLessThanOrEqual(10);
  expect(report.vignette).toBeLessThanOrEqual(6);
  expect(report.previewVignette).toBeLessThanOrEqual(6);
  for (const { spread, corr } of report.grains) {
    for (const ratio of spread) {
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    }
    for (const off of corr) expect(Math.abs(off)).toBeLessThan(0.15);
  }
  for (const { worst, alpha } of report.cutout) {
    expect(worst).toBeLessThanOrEqual(2);
    expect(alpha).toEqual([255, 0]);
  }
  for (const worst of report.previewNoise) expect(worst).toBeLessThanOrEqual(10);
  for (const ratio of report.previewGrain) {
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  }
});
