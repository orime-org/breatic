// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Frontend text extraction for non-media files dropped on the canvas. A
 * non-media file becomes a text node whose content is its readable text:
 * `text/*` is read directly; pdf / docx / xlsx are parsed in the browser
 * (pdf.js / mammoth / SheetJS) — all dynamically imported so these heavy
 * libraries stay out of the initial bundle. Anything with no extractor
 * throws, and the caller writes an "Extraction failed" error onto the node.
 *
 * Extraction runs entirely in the uploader's own browser tab: the libraries
 * are browser-native, no credits / queue are involved, and parsing an
 * untrusted document in the uploader's own sandbox can't reach the server or
 * other users — safer than server-side parsing.
 */

/** Which extractor a file's MIME type routes to (or none). */
export type ExtractorKind = 'text' | 'pdf' | 'docx' | 'xlsx';

/**
 * `application/*` MIME types that are really plain text and can be read
 * directly (they are not `text/*` but carry readable source / data text).
 */
const TEXT_LIKE_APPLICATION = new Set<string>([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-yaml',
  'application/yaml',
]);

/** Office Open XML Word document MIME (.docx). */
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Office Open XML spreadsheet MIME (.xlsx). */
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Legacy binary Excel MIME (.xls) — SheetJS reads it too. */
const XLS_MIME = 'application/vnd.ms-excel';

/**
 * Map a file's MIME type to the extractor it needs, or `null` when no
 * extractor handles it (arbitrary binary / media — media is classified by
 * `fileToNodeSpec` and never reaches here).
 * @param mime - The file's MIME type string (`File.type`).
 * @returns The extractor kind, or `null` when unsupported.
 */
export function pickExtractor(mime: string): ExtractorKind | null {
  if (mime.startsWith('text/') || TEXT_LIKE_APPLICATION.has(mime)) return 'text';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === DOCX_MIME) return 'docx';
  if (mime === XLSX_MIME || mime === XLS_MIME) return 'xlsx';
  return null;
}

/** Injected document parsers — real implementations dynamically import the libs. */
export interface ExtractDeps {
  /** Extract a PDF's text from its bytes. */
  pdf: (buffer: ArrayBuffer) => Promise<string>;
  /** Extract a .docx document's text from its bytes. */
  docx: (buffer: ArrayBuffer) => Promise<string>;
  /** Extract a spreadsheet's text (all sheets as CSV) from its bytes. */
  xlsx: (buffer: ArrayBuffer) => Promise<string>;
}

/**
 * Extract a PDF's text with pdf.js, concatenating every page. The worker is
 * pointed at the installed `pdfjs-dist` build via a Vite-bundled URL so its
 * version always matches the API.
 * @param buffer - The PDF file bytes.
 * @returns The document's text, pages joined by blank lines.
 */
async function extractPdf(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    );
  }
  return pages.join('\n\n');
}

/**
 * Extract a .docx document's raw text with mammoth.
 * @param buffer - The .docx file bytes.
 * @returns The document's plain text.
 */
async function extractDocx(buffer: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

/**
 * Extract a spreadsheet's text with SheetJS — every sheet rendered as CSV.
 * @param buffer - The .xlsx / .xls file bytes.
 * @returns All sheets as CSV, joined by blank lines.
 */
async function extractXlsx(buffer: ArrayBuffer): Promise<string> {
  const xlsx = await import('xlsx');
  const workbook = xlsx.read(buffer, { type: 'array' });
  return workbook.SheetNames.map((name) =>
    xlsx.utils.sheet_to_csv(workbook.Sheets[name]),
  ).join('\n\n');
}

/** Real document parsers, each dynamically importing its library on demand. */
export const defaultExtractDeps: ExtractDeps = {
  pdf: extractPdf,
  docx: extractDocx,
  xlsx: extractXlsx,
};

/**
 * Extract a non-media file's readable text. `text/*` is read inline; pdf /
 * docx / xlsx are parsed through the injected `deps`. Throws when no
 * extractor handles the type so the caller can write an error onto the node.
 * @param file - The dropped non-media file.
 * @param deps - Injected document parsers (defaults to the real libraries).
 * @returns The file's extracted text.
 * @throws {Error} When the file's type has no extractor.
 */
export async function extractText(
  file: File,
  deps: ExtractDeps = defaultExtractDeps,
): Promise<string> {
  const kind = pickExtractor(file.type);
  if (kind === 'text') return file.text();
  if (kind === 'pdf') return deps.pdf(await file.arrayBuffer());
  if (kind === 'docx') return deps.docx(await file.arrayBuffer());
  if (kind === 'xlsx') return deps.xlsx(await file.arrayBuffer());
  throw new Error(`No text extractor for "${file.type || 'unknown type'}"`);
}
