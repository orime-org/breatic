// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";

import { pdfText } from "../pdf-text.js";

/**
 * A minimal valid PDF with one line of Helvetica text per page, its xref
 * offsets computed so a strict parser accepts it.
 * @param lines - Each page's text; ASCII without parentheses or backslashes.
 * @returns The PDF's bytes.
 */
function pdfOf(lines: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = lines.map((_, i) => 3 + i * 2);
  const fontId = 3 + lines.length * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${lines.length} >>`;
  lines.forEach((line, i) => {
    const pageId = pageIds[i] ?? 0;
    const content = `BT /F1 24 Tf 72 720 Td (${line}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("pdfText", () => {
  it("reads every page's text and counts the pages", async () => {
    const { text, pages } = await pdfText(pdfOf(["Hello page one", "Second page here"]));

    expect(pages).toBe(2);
    // How pages are joined is unpdf's choice; the words and their order are ours.
    expect(text.replace(/\s+/g, " ").trim()).toBe("Hello page one Second page here");
  });

  it("counts a one-page PDF as one page", async () => {
    const { text, pages } = await pdfText(pdfOf(["Only page"]));

    expect(pages).toBe(1);
    expect(text.trim()).toBe("Only page");
  });
});
