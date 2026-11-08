// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader's request and answer, as the ingest Worker and our server
 * both parse them (inner#1664 design §6.2), and the failure lines a web_fetch
 * call that reads nothing is shown under (design §6.1).
 */
import { describe, it, expect } from "vitest";

import { FAILURE_LINES } from "@shared/agent/tool-failure.js";
import {
  READ_PAGE_STATUSES,
  readPageResultSchema,
  readPagesAnswerSchema,
  readPagesRequestSchema,
  type ReadPagesAnswer,
  type ReadPagesRequest,
} from "@shared/agent/read-pages.js";

const REQUEST: ReadPagesRequest = {
  urls: ["https://example.com/a", "http://b.org/doc.pdf"],
  deadlineAt: 1_800_000_000_000,
  pageTimeoutMs: 30_000,
  settleMs: 8_000,
  concurrency: 6,
  maxBytes: 20_971_520,
};

describe("readPagesRequestSchema", () => {
  it("accepts a request for http and https pages, unchanged", () => {
    expect(readPagesRequestSchema.parse(REQUEST)).toEqual(REQUEST);
  });

  it.each(["ftp://example.com/a", "file:///etc/passwd", "javascript:alert(1)", "example.com/a", "not a url"])(
    "rejects a request naming %s",
    (url) => {
      expect(readPagesRequestSchema.safeParse({ ...REQUEST, urls: ["https://example.com/a", url] }).success).toBe(
        false,
      );
    },
  );

  it("rejects a request naming no pages", () => {
    expect(readPagesRequestSchema.safeParse({ ...REQUEST, urls: [] }).success).toBe(false);
  });

  it("rejects a request missing one of its limits", () => {
    const { deadlineAt: _dropped, ...withoutDeadline } = REQUEST;
    expect(readPagesRequestSchema.safeParse(withoutDeadline).success).toBe(false);
  });
});

describe("readPagesAnswerSchema", () => {
  it.each(READ_PAGE_STATUSES.map((status) => [status]))("accepts a page that ended %s", (status) => {
    const answer: ReadPagesAnswer = {
      pages: [{ url: "https://example.com/a", status }],
      usage: { wallMs: 41_700, cpuUsec: null },
    };
    expect(readPagesAnswerSchema.parse(answer)).toEqual(answer);
  });

  it("accepts a page read in full, and CPU time the container measured", () => {
    const answer: ReadPagesAnswer = {
      pages: [
        {
          url: "http://arxiv.org/pdf/1",
          status: "ok",
          httpStatus: 200,
          finalUrl: "https://arxiv.org/pdf/1",
          title: "A paper",
          kind: "pdf",
          pages: 15,
          text: "Abstract ...",
        },
        { url: "https://example.com/gone", status: "unreachable", httpStatus: 404 },
      ],
      usage: { wallMs: 12_000, cpuUsec: 3_456_789 },
    };
    expect(readPagesAnswerSchema.parse(answer)).toEqual(answer);
  });

  it("rejects a status it does not know", () => {
    expect(
      readPagesAnswerSchema.safeParse({
        pages: [{ url: "https://example.com/a", status: "maybe" }],
        usage: { wallMs: 1, cpuUsec: null },
      }).success,
    ).toBe(false);
  });

  it("rejects an answer without usage", () => {
    expect(readPagesAnswerSchema.safeParse({ pages: [{ url: "https://example.com/a", status: "ok" }] }).success).toBe(
      false,
    );
  });

  it("rejects usage whose CPU time is neither a number nor null", () => {
    expect(
      readPagesAnswerSchema.safeParse({
        pages: [{ url: "https://example.com/a", status: "ok" }],
        usage: { wallMs: 1, cpuUsec: "lots" },
      }).success,
    ).toBe(false);
  });
});

describe("readPageResultSchema", () => {
  it("accepts one page's result, unchanged", () => {
    const page = { url: "https://example.com/a", status: "needs_login" as const, httpStatus: 401 };
    expect(readPageResultSchema.parse(page)).toEqual(page);
  });

  it("rejects a kind other than html or pdf", () => {
    expect(readPageResultSchema.safeParse({ url: "https://example.com/a", status: "ok", kind: "image" }).success).toBe(
      false,
    );
  });
});

describe("the failure lines web_fetch adds", () => {
  it.each([
    "linkNotInConversation",
    "pageNeedsLogin",
    "pageRefused",
    "pageTooSlow",
    "pageEmpty",
    "pagesUnreadable",
  ] as const)("names %s under chat.tool.failure", (key) => {
    expect(FAILURE_LINES[key]).toBe(`chat.tool.failure.${key}`);
  });
});
