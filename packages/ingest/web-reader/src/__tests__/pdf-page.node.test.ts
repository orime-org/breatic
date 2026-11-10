// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Plan §9 rows F and P: a download is read as a PDF only when its bytes are
 * one, and a PDF the parser cannot open (encrypted, corrupt) is a page of a
 * type the reader cannot read, not a failure of the whole call.
 */

import { describe, expect, it } from "vitest";

import { readPdf } from "../pdf-page.js";

const URL_ASKED = "http://example.org/report.pdf";
const URL_FINAL = "https://example.org/report.pdf";

/**
 * A minimal PDF with one line of Helvetica text per page, its xref offsets
 * exact.
 * @param lines - Each page's text; ASCII without parentheses or backslashes.
 * @param trailerExtra - More entries for the trailer dictionary.
 * @returns The PDF's bytes.
 */
function pdfOf(lines: string[], trailerExtra = ""): Uint8Array {
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
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A standard security handler whose empty user password does not open it. */
const ENCRYPT =
  `/Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /O (${"A".repeat(32)}) /U (${"A".repeat(32)}) /P -4 >> ` +
  "/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] ";

describe("readPdf", () => {
  it("reads a PDF's text and pages", async () => {
    const page = await readPdf(URL_ASKED, URL_FINAL, pdfOf(["Hello page one", "Second page here"]));

    expect(page).toMatchObject({ url: URL_ASKED, status: "ok", finalUrl: URL_FINAL, kind: "pdf", pages: 2 });
    expect(page.text?.replace(/\s+/g, " ").trim()).toBe("Hello page one Second page here");
  });

  it("records a PDF with no text as empty", async () => {
    const page = await readPdf(URL_ASKED, URL_FINAL, pdfOf([""]));

    expect(page).toEqual({ url: URL_ASKED, status: "empty", finalUrl: URL_FINAL, kind: "pdf", pages: 1 });
  });

  it("records bytes that are not a PDF as unsupported_type", async () => {
    const page = await readPdf(URL_ASKED, URL_FINAL, new TextEncoder().encode("PK\u0003\u0004 a zip archive"));

    expect(page).toEqual({ url: URL_ASKED, status: "unsupported_type", finalUrl: URL_FINAL });
  });

  it.each([
    ["an encrypted PDF", pdfOf(["Secret"], ENCRYPT)],
    ["a corrupt PDF", new TextEncoder().encode("%PDF-1.4\nthis is not a pdf at all\n%%EOF")],
    ["a PDF cut off after its header", new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog")],
  ])("records %s, which the parser rejects, as unsupported_type rather than throwing", async (_label, bytes) => {
    const page = await readPdf(URL_ASKED, URL_FINAL, bytes);

    expect(page).toEqual({ url: URL_ASKED, status: "unsupported_type", finalUrl: URL_FINAL });
  });
});
