// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links one turn's `web_fetch` may read (inner#1664, design 6.0).
 *
 * Only what came from the user's side counts: the user's own messages (the
 * clock, Space list, open Space body, attachments and typed words all render
 * into the row's `forModel`), and the named structured fields of a few tool
 * results. Anything the model wrote -- its prose, its tool inputs, a search
 * query echoed back, the option labels of a questionnaire, a page it failed
 * to read -- never makes a link readable, so a page that tells the model to
 * build a link out of the user's data cannot get it fetched.
 *
 * The rows below are built in the shapes the store hands out: a user row's
 * `forModel` holds the message as sent, a reply row's holds the protocol
 * messages, and its tool parts hold each tool's own output (a Space read's
 * part has its content stripped by `cardOutputOf`, so the content is read
 * from the reply row's `forModel` tool result).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import type { ModelMessage } from "ai";
import type { ChatAttachedChip, ChatCurrentSpace, MessagePart, SharedSpace } from "@breatic/shared";

import type { ReplayRow } from "@server/agent/history-replay.js";
import { askResultForModel, cardOutputOf } from "@server/agent/ask-result.js";
import { userMessageForModel } from "@server/agent/user-turn.js";

const getMessagesForLlm = vi.fn(async (_id: string, _from: number, _before?: number): Promise<ReplayRow[]> => []);

// Both paths the module may read the conversation through: the services
// barrel and the service file itself.
vi.mock("@server/modules", () => ({ conversationService: { getMessagesForLlm } }));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ getMessagesForLlm }));

const { makePageLinks, pageLinksForTurn } = await import("@server/agent/page-links.js");

const CLOCK = "Current time for the user: 2026-11-08 10:00 (Asia/Singapore).";

/**
 * A stored user row whose `forModel` holds the message as it was sent.
 * @param content - The message the model was sent.
 * @param turnIndex - Its turn.
 * @returns The row.
 */
function userRow(content: ModelMessage["content"], turnIndex = 1): ReplayRow {
  return {
    role: "user",
    parts: [{ type: "text", text: "(typed words)" }],
    content: "(typed words)",
    ts: "2026-11-08T02:00:00Z",
    turnIndex,
    forModel: { messages: [{ role: "user", content } as ModelMessage] },
  };
}

/**
 * A stored reply row.
 * @param parts - What the panel draws from.
 * @param messages - What the model was sent, as kept in `forModel`.
 * @param turnIndex - Its turn.
 * @returns The row.
 */
function replyRow(parts: MessagePart[], messages: ModelMessage[], turnIndex = 1): ReplayRow {
  return {
    role: "assistant",
    parts,
    content: "",
    ts: "2026-11-08T02:00:01Z",
    turnIndex,
    forModel: { messages, prefixHash: "h", turnTokens: 1, endTokens: 1 },
  };
}

/**
 * A finished tool use as the store keeps it.
 * @param toolName - The tool.
 * @param input - What the model sent.
 * @param output - What the tool returned.
 * @param forModel - What the model was given.
 * @returns The part.
 */
function toolPart(toolName: string, input: Record<string, unknown>, output: unknown, forModel: string): MessagePart {
  return {
    type: "tool",
    toolCallId: `call-${toolName}`,
    toolName,
    input,
    status: "success",
    output,
    forModel: { type: "text", value: forModel },
  };
}

/**
 * The protocol pair of one tool use, as a reply row's `forModel` keeps it.
 * @param toolName - The tool.
 * @param input - What the model sent.
 * @param output - What the model was given.
 * @returns The call and its result.
 */
function sentPair(toolName: string, input: Record<string, unknown>, output: { type: "text"; value: string } | { type: "json"; value: unknown }): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `call-${toolName}`, toolName, input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `call-${toolName}`, toolName, output }] } as ModelMessage,
  ];
}

/**
 * A successful `web_search` output.
 * @param query - What the model searched for.
 * @param urls - The pages found.
 * @returns The output as the tool returns it.
 */
function searchOutput(query: string, urls: string[]): Record<string, unknown> {
  return {
    query,
    sources: urls.map((url, i) => ({ url, title: `Page ${String(i + 1)}`, publisher: "Example", excerpts: ["Some text."], index: i + 1 })),
    sent: urls.length,
  };
}

/**
 * A `web_fetch` output with one page read and one that failed.
 * @param read - The page read: its requested and final address, and the links in its text.
 * @param read.url - Requested address.
 * @param read.finalUrl - Where the reader ended up.
 * @param read.links - Links in the page's text.
 * @param failedUrl - The page that could not be read.
 * @returns The output as the tool returns it.
 */
function fetchOutput(read: { url: string; finalUrl: string; links: string[] }, failedUrl: string): Record<string, unknown> {
  return {
    pages: [
      {
        url: read.url,
        status: "ok",
        final_url: read.finalUrl,
        title: "Read page",
        kind: "html",
        chars_total: 30,
        start: 0,
        end: 30,
        next_start: null,
        text: "Some text of the page.",
        links: read.links,
        index: 1,
      },
      { url: failedUrl, status: "unreachable", links: [] },
    ],
    sources: [{ url: read.url, title: "Read page", publisher: "Example", index: 1 }],
  };
}

beforeEach(() => {
  getMessagesForLlm.mockReset();
  getMessagesForLlm.mockResolvedValue([]);
});

describe("links from a user row's forModel", () => {
  it("allows a link the user typed in their message", () => {
    const links = makePageLinks();
    links.addRow(userRow(`${CLOCK}\n\nWhat does https://typed.example/post say?`));
    expect(links.urlFor("https://typed.example/post") !== undefined).toBe(true);
  });

  it("allows a link inside a text attachment", () => {
    const chip: ChatAttachedChip = {
      id: "chip-1",
      type: "text",
      name: "notes",
      data_snapshot: { text: "Reference: https://attached.example/brief for the tone" },
    };
    const content = userMessageForModel(CLOCK, { chips: [chip], message: "Follow the attachment" });
    expect(JSON.stringify(content)).toContain("https://attached.example/brief");

    const links = makePageLinks();
    links.addRow(userRow(content));
    expect(links.urlFor("https://attached.example/brief") !== undefined).toBe(true);
  });

  it("allows a link on its own line in the open document Space's body", () => {
    const current: ChatCurrentSpace = {
      id: "d1",
      name: "Brief",
      kind: "document",
      state: "loaded",
      content: "Client brief:\nhttps://open-space.example/spec\nDeadline Friday",
      total_chars: 63,
    };
    const content = userMessageForModel(CLOCK, { chips: [], message: "Read the spec it links", current_space: current });

    const links = makePageLinks();
    links.addRow(userRow(content));
    expect(links.urlFor("https://open-space.example/spec") !== undefined).toBe(true);
  });

  it("allows a link in a user message sent as text and picture parts", () => {
    const links = makePageLinks();
    links.addRow(
      userRow([
        { type: "text", text: `${CLOCK}\n\nCompare this picture with https://parts.example/gallery please` },
        { type: "file", data: "https://cdn.example/p.jpg", mediaType: "image/jpeg" },
      ]),
    );
    expect(links.urlFor("https://parts.example/gallery") !== undefined).toBe(true);
  });

  it("does not allow a link that is only in a reply row's text", () => {
    const links = makePageLinks();
    links.addRow(
      replyRow(
        [{ type: "text", text: "You could read https://model-prose.example/guess for more." }],
        [{ role: "assistant", content: "You could read https://model-prose.example/guess for more." }],
      ),
    );
    expect(links.urlFor("https://model-prose.example/guess") !== undefined).toBe(false);
  });
});

describe("links from the structured fields of a reply row's tool results", () => {
  it("allows the address of every page a successful web_search found", () => {
    const output = searchOutput("cat food reviews", ["https://found-1.example/a", "https://found-2.example/b"]);
    const links = makePageLinks();
    links.addRow(replyRow([toolPart("web_search", { query: "cat food reviews" }, output, "Results")], sentPair("web_search", { query: "cat food reviews" }, { type: "text", value: "Results" })));

    expect(links.urlFor("https://found-1.example/a") !== undefined).toBe(true);
    expect(links.urlFor("https://found-2.example/b") !== undefined).toBe(true);
  });

  it("does not allow a link that is only in a web_search query", () => {
    const query = "https://query-only.example/secret?data=abc";
    const output = searchOutput(query, ["https://found.example/a"]);
    const links = makePageLinks();
    links.addRow(
      replyRow(
        [toolPart("web_search", { query }, output, `Results for: ${query}`)],
        sentPair("web_search", { query }, { type: "text", value: `Results for: ${query}` }),
      ),
    );

    expect(links.urlFor(query) !== undefined).toBe(false);
    expect(links.urlFor("https://found.example/a") !== undefined).toBe(true);
  });

  it("allows the final address and the in-text links of a page web_fetch read, never the address of a page it failed to read", () => {
    const output = fetchOutput(
      { url: "https://asked.example/post", finalUrl: "https://moved.example/post-final", links: ["https://cited.example/source"] },
      "https://failed.example/missing",
    );
    const input = { pages: [{ url: "https://asked.example/post" }, { url: "https://failed.example/missing" }] };
    const links = makePageLinks();
    links.addRow(replyRow([toolPart("web_fetch", input, output, "Pages")], sentPair("web_fetch", input, { type: "text", value: "Pages" })));

    expect(links.urlFor("https://moved.example/post-final") !== undefined).toBe(true);
    expect(links.urlFor("https://cited.example/source") !== undefined).toBe(true);
    expect(links.urlFor("https://failed.example/missing") !== undefined).toBe(false);
  });

  it("allows a link in a Space read back through request_space_content, from the reply row's forModel tool result", () => {
    const shared: SharedSpace[] = [
      { id: "d1", name: "Brief", kind: "document", state: "read", content: "See https://space-read.example/ref here", total_chars: 39 },
    ];
    const input = { reason: "To read the brief.", spaces: [{ id: "d1" }] };
    const result = askResultForModel("call-request_space_content", { spaces: shared }, "request_space_content");
    const links = makePageLinks();
    links.addRow(
      replyRow(
        [
          {
            type: "tool",
            toolCallId: "call-request_space_content",
            toolName: "request_space_content",
            input,
            status: "success",
            output: cardOutputOf({ spaces: shared }),
          },
        ],
        [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-request_space_content", toolName: "request_space_content", input }] }, result],
      ),
    );
    expect(JSON.stringify(cardOutputOf({ spaces: shared }))).not.toContain("space-read.example");

    expect(links.urlFor("https://space-read.example/ref") !== undefined).toBe(true);
  });

  it("allows what the user wrote on a questionnaire's Other line, never a link that is only an option label the user picked", () => {
    const optionLink = "https://option-label.example/picked";
    const input = {
      questions: [
        { header: "Source", question: "Which page?", options: [{ label: optionLink }, { label: "None" }], multiSelect: true },
      ],
    };
    const answer = { answers: [{ index: 0, selected: [optionLink], other: "Also read https://user-other.example/page" }] };
    const links = makePageLinks();
    links.addRow(
      replyRow(
        [{ type: "tool", toolCallId: "call-ask_user", toolName: "ask_user", input, status: "success", output: answer }],
        [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-ask_user", toolName: "ask_user", input }] }, askResultForModel("call-ask_user", answer)],
      ),
    );

    expect(links.urlFor("https://user-other.example/page") !== undefined).toBe(true);
    expect(links.urlFor(optionLink) !== undefined).toBe(false);
  });

  it.each(["read_conversation", "search_conversations"])(
    "allows the userLinks of %s, never a link only in its text",
    (toolName) => {
      const output = {
        text: "user: see https://other-chat-user.example/a\nassistant: try https://other-chat-model.example/b",
        userLinks: ["https://other-chat-user.example/a"],
      };
      const links = makePageLinks();
      links.addRow(replyRow([toolPart(toolName, { conversation_id: "c2" }, output, output.text)], sentPair(toolName, { conversation_id: "c2" }, { type: "text", value: output.text })));

      expect(links.urlFor("https://other-chat-user.example/a") !== undefined).toBe(true);
      expect(links.urlFor("https://other-chat-model.example/b") !== undefined).toBe(false);
    },
  );

  it("does not read a link out of another tool's output", () => {
    const output = { url: "https://media.example/clip.mp4", summary: "A clip." };
    const links = makePageLinks();
    links.addRow(replyRow([toolPart("understand_media", { url: "https://media.example/clip.mp4" }, output, "A clip.")], sentPair("understand_media", { url: "https://media.example/clip.mp4" }, { type: "text", value: "A clip." })));

    expect(links.urlFor("https://media.example/clip.mp4") !== undefined).toBe(false);
  });
});

describe("this turn's message and tool results", () => {
  it("allows a link in the message sent to the model this turn", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: `${CLOCK}\n\n## User message\n\nSummarise https://this-turn.example/news thanks` });
    expect(links.urlFor("https://this-turn.example/news") !== undefined).toBe(true);
  });

  it("allows the sources of this turn's web_search, never its query", () => {
    const links = makePageLinks();
    links.addToolResult("web_search", searchOutput("https://query.example/x", ["https://now-found.example/a"]));
    expect(links.urlFor("https://now-found.example/a") !== undefined).toBe(true);
    expect(links.urlFor("https://query.example/x") !== undefined).toBe(false);
  });

  it("allows the final address and links of a page this turn's web_fetch read, never a failed page", () => {
    const links = makePageLinks();
    links.addToolResult(
      "web_fetch",
      fetchOutput({ url: "https://a.example/p", finalUrl: "https://b.example/p", links: ["https://c.example/q"] }, "https://d.example/gone"),
    );
    expect(links.urlFor("https://b.example/p") !== undefined).toBe(true);
    expect(links.urlFor("https://c.example/q") !== undefined).toBe(true);
    expect(links.urlFor("https://d.example/gone") !== undefined).toBe(false);
  });

  it.each(["read_conversation", "search_conversations"])("allows the userLinks of this turn's %s, never its text", (toolName) => {
    const links = makePageLinks();
    links.addToolResult(toolName, { text: "assistant: https://said-by-model.example/z", userLinks: ["https://said-by-user.example/y"] });
    expect(links.urlFor("https://said-by-user.example/y") !== undefined).toBe(true);
    expect(links.urlFor("https://said-by-model.example/z") !== undefined).toBe(false);
  });

  it("allows nothing from a tool it does not list", () => {
    const links = makePageLinks();
    links.addToolResult("save_image", { url: "https://saved.example/p.png", mimeType: "image/png", width: 1, height: 1 });
    expect(links.urlFor("https://saved.example/p.png") !== undefined).toBe(false);
  });

  it("allows nothing before anything is added", () => {
    expect(makePageLinks().urlFor("https://anything.example/") !== undefined).toBe(false);
  });
});

describe("how urlFor compares two spellings of one link", () => {
  it("compares by the page key: scheme, host case, fragment, trailing slash and percent-encoding do not matter", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "Read https://Docs.Example.com/guide/%E4%B8%AD%E6%96%87/ please" });

    expect(links.urlFor("docs.example.com/guide/中文") !== undefined).toBe(true);
    expect(links.urlFor("http://docs.example.com/guide/中文#intro") !== undefined).toBe(true);
    expect(links.urlFor("https://docs.example.com/guide/%E4%B8%AD%E6%96%87") !== undefined).toBe(true);
  });

  it("allows a link the user wrote without a scheme when the model asks with one", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "看看 example.org/news/today 这篇" });
    expect(links.urlFor("https://example.org/news/today") !== undefined).toBe(true);
  });

  it("keeps the query string as part of the page", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "Open https://shop.example/item?id=1 now" });
    expect(links.urlFor("https://shop.example/item?id=1") !== undefined).toBe(true);
    expect(links.urlFor("https://shop.example/item?id=2") !== undefined).toBe(false);
  });
});

describe("urlFor: the spelling the conversation recorded (plan §9 A)", () => {
  it("answers the first spelling the set recorded for a link's key", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "Read https://Docs.Example.com/guide/%E4%B8%AD%E6%96%87/ please" });
    links.addToolResult("web_search", searchOutput("q", ["http://docs.example.com/guide/中文"]));

    expect(links.urlFor("docs.example.com/guide/中文")).toBe("https://Docs.Example.com/guide/%E4%B8%AD%E6%96%87/");
    expect(links.urlFor("http://docs.example.com/guide/中文#intro")).toBe(
      "https://Docs.Example.com/guide/%E4%B8%AD%E6%96%87/",
    );
  });

  it("never answers what the model added to a held link", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "Read https://evil.com/p please" });

    for (const asked of [
      "https://evil.com/p#SECRET",
      "https://SECRET:x@evil.com/p",
      "https://evil.com/p///",
      "https://evil.com/%70",
    ]) {
      expect(links.urlFor(asked), asked).toBe("https://evil.com/p");
    }
  });

  it("adds https to a link the user wrote without a scheme", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "看看 example.org/news/today 这篇" });

    expect(links.urlFor("https://example.org/news/today")).toBe("https://example.org/news/today");
    expect(links.urlFor("http://example.org/news/today")).toBe("https://example.org/news/today");
  });

  it("keeps the scheme a link was recorded with", () => {
    const links = makePageLinks();
    links.addToolResult("web_search", searchOutput("q", ["http://plain.example/a"]));

    expect(links.urlFor("https://plain.example/a")).toBe("http://plain.example/a");
  });

  // Plan §13.2 rows 4 and 12: a spelling web_fetch's own input would refuse is
  // never recorded, so it can never be the spelling a short link maps to.
  it("does not record a web_search address longer than a page address may be", () => {
    const links = makePageLinks();
    links.addToolResult("web_search", searchOutput("q", [`https://a.com/x#${"f".repeat(2100)}`]));

    expect(links.urlFor("https://a.com/x")).toBeUndefined();
  });

  it("records the next valid spelling of a page whose first spelling was too long", () => {
    const links = makePageLinks();
    links.addToolResult("web_search", searchOutput("q", [`https://a.com/x#${"f".repeat(2100)}`, "https://a.com/x"]));

    expect(links.urlFor("https://a.com/x#top")).toBe("https://a.com/x");
  });

  it("does not record a percent-encoded spelling longer than a page address may be, nor answer its short decoded form", () => {
    const encoded = `https://a.com/${"%E4%B8%AD".repeat(240)}`;
    expect(encoded.length).toBeGreaterThan(2048);
    const links = makePageLinks();
    links.addToolResult("web_search", searchOutput("q", [encoded]));

    expect(links.urlFor(`https://a.com/${"\u4e2d".repeat(240)}`)).toBeUndefined();
  });

  it("answers nothing for a link the set does not hold", () => {
    const links = makePageLinks();
    links.addUserMessage({ role: "user", content: "Open https://shop.example/item?id=1 now" });

    expect(links.urlFor("https://shop.example/item?id=2")).toBeUndefined();
    expect(makePageLinks().urlFor("https://anything.example/")).toBeUndefined();
  });
});

describe("pageLinksForTurn", () => {
  it("reads the conversation up to and including the memory watermark (plan §9 C)", async () => {
    getMessagesForLlm.mockResolvedValue([userRow(`${CLOCK}\n\nOld turn: https://folded-into-memory.example/a`, 1)]);

    const links = await pageLinksForTurn("c1", 3);

    expect(getMessagesForLlm).toHaveBeenCalledTimes(1);
    expect(getMessagesForLlm).toHaveBeenCalledWith("c1", 0, 4);
    expect(links.urlFor("https://folded-into-memory.example/a") !== undefined).toBe(true);
  });

  it("reads from the first turn when nothing has been folded", async () => {
    await pageLinksForTurn("c1", 0);

    expect(getMessagesForLlm).toHaveBeenCalledWith("c1", 0, 1);
  });

  it("adds every row it read", async () => {
    getMessagesForLlm.mockResolvedValue([
      userRow(`${CLOCK}\n\nOld turn: https://folded-into-memory.example/a`, 1),
      replyRow(
        [toolPart("web_search", { query: "q" }, searchOutput("q", ["https://old-search.example/b"]), "Results")],
        sentPair("web_search", { query: "q" }, { type: "text", value: "Results" }),
        1,
      ),
      userRow(`${CLOCK}\n\nRecent turn: https://recent.example/c`, 6),
    ]);

    const links = await pageLinksForTurn("c1", 6);

    expect(links.urlFor("https://folded-into-memory.example/a") !== undefined).toBe(true);
    expect(links.urlFor("https://old-search.example/b") !== undefined).toBe(true);
    expect(links.urlFor("https://recent.example/c") !== undefined).toBe(true);
    expect(links.urlFor("https://never-said.example/d") !== undefined).toBe(false);
  });

  it("returns a set that this turn can still add to", async () => {
    const links = await pageLinksForTurn("c1", 2);
    links.addToolResult("web_search", searchOutput("q", ["https://later.example/x"]));
    expect(links.urlFor("https://later.example/x") !== undefined).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The invariant: a link the model wrote never becomes readable.
// ---------------------------------------------------------------------------

/** A host the user's side never writes: every label lives under `model-only.test`. */
const modelHost = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/).map((label) => `${label}.model-only.test`);
const pathSegments = fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 0, maxLength: 3 });

/** A link the model makes up, with the spellings the model may ask with. */
const modelLink = fc.tuple(modelHost, pathSegments).map(([host, path]) => {
  const tail = path.length === 0 ? "" : `/${path.join("/")}`;
  const base = `${host}${tail}`;
  return {
    written: `https://${base}`,
    spellings: [`https://${base}`, `http://${base}/`, base, `https://${host.toUpperCase()}${tail}#x`],
  };
});

/** One way the model's own words reach a stored row or a tool result. */
type Placement =
  | "reply_text"
  | "reply_forModel_text"
  | "tool_input"
  | "search_query"
  | "search_query_result"
  | "ask_option_label"
  | "fetch_failed_page"
  | "fetch_failed_page_result"
  | "record_text";

const placements: Placement[] = [
  "reply_text",
  "reply_forModel_text",
  "tool_input",
  "search_query",
  "search_query_result",
  "ask_option_label",
  "fetch_failed_page",
  "fetch_failed_page_result",
  "record_text",
];

/**
 * Put a model-written link somewhere the model writes, plus a user link that must stay readable.
 * @param placement - Where the model's link goes.
 * @param link - The model's link.
 * @param control - A link the user's side did give, in the same place's structured field.
 * @param links - The set to add to.
 */
function place(placement: Placement, link: string, control: string, links: ReturnType<typeof makePageLinks>): void {
  switch (placement) {
    case "reply_text":
      links.addRow(replyRow([{ type: "text", text: `Try ${link} next.` }], [{ role: "assistant", content: `Try ${link} next.` }]));
      links.addRow(userRow(`${CLOCK}\n\n${control} is mine`));
      return;
    case "reply_forModel_text":
      links.addRow(replyRow([], [{ role: "assistant", content: [{ type: "text", text: `See ${link} below` }] }]));
      links.addUserMessage({ role: "user", content: `Here: ${control} ok` });
      return;
    case "tool_input": {
      const input = { pages: [{ url: link }] };
      links.addRow(replyRow([{ type: "tool", toolCallId: "t1", toolName: "web_fetch", input, status: "error" }], sentPair("web_fetch", input, { type: "text", value: "failed" })));
      links.addToolResult("web_search", searchOutput("q", [control]));
      return;
    }
    case "search_query":
      links.addToolResult("web_search", searchOutput(link, [control]));
      return;
    case "search_query_result":
      links.addRow(
        replyRow(
          [toolPart("web_search", { query: link }, searchOutput(link, [control]), `Results for: ${link}`)],
          sentPair("web_search", { query: link }, { type: "text", value: `Results for: ${link}` }),
        ),
      );
      return;
    case "ask_option_label": {
      const input = { questions: [{ header: "Pick", question: "Which?", options: [{ label: link }, { label: "Neither" }], multiSelect: true }] };
      const answer = { answers: [{ index: 0, selected: [link], other: `and ${control} too` }] };
      links.addRow(
        replyRow(
          [{ type: "tool", toolCallId: "call-ask_user", toolName: "ask_user", input, status: "success", output: answer }],
          [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-ask_user", toolName: "ask_user", input }] }, askResultForModel("call-ask_user", answer)],
        ),
      );
      return;
    }
    case "fetch_failed_page":
      links.addToolResult("web_fetch", fetchOutput({ url: control, finalUrl: control, links: [] }, link));
      return;
    case "fetch_failed_page_result": {
      const output = fetchOutput({ url: control, finalUrl: control, links: [] }, link);
      const input = { pages: [{ url: control }, { url: link }] };
      links.addRow(replyRow([toolPart("web_fetch", input, output, `${link}: unreachable`)], sentPair("web_fetch", input, { type: "text", value: `${link}: unreachable` })));
      return;
    }
    case "record_text":
      links.addToolResult("read_conversation", { text: `assistant: ${link}`, userLinks: [control] });
      return;
  }
}

describe("the invariant (fast-check)", () => {
  it("never allows a link that appears only where the model writes, whatever is added and in what order", () => {
    fc.assert(
      fc.property(
        modelLink,
        fc.array(fc.constantFrom(...placements), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 999 }),
        (link, chosen, n) => {
          const control = `https://user-side-${String(n)}.example/page`;
          const links = makePageLinks();
          for (const placement of chosen) place(placement, link.written, control, links);

          for (const spelling of link.spellings) {
            expect(links.urlFor(spelling)).toBeUndefined();
          }
          // The same calls did make the user's side readable, so the set was not just empty.
          expect(links.urlFor(control) !== undefined).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
