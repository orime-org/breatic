// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Propose a wired group of nodes for the reader to place (#229).
 *
 * The tool hands its input straight back: the card the reader presses is
 * drawn from it, and the placing happens on the canvas. What stands between a
 * careless proposal and that card is `checkProposal`, and every rule it
 * applies is read off the live catalog -- which modes a node offers, which
 * models a mode can reach, and whether that mode needs material only the
 * reader has.
 *
 * A mode that needs material is proposed with an empty node to put it in, and
 * the reply says what goes where. How that material reaches the generation
 * differs by model: the reference
 * pool is fed by an edge and picked by a mention in the prompt, a slot on the
 * panel's toolbar is picked by the reader clicking a node on the canvas.
 * Which of the two this model uses is read off the catalog here and travels
 * with the proposal.
 *
 * Every character of this tool's description and its field descriptions goes
 * out with every turn of every conversation, and is measured against the same
 * budget the messages are (`payload-size.ts`). The refusals below teach the
 * model at the moment it needs it, so the descriptions say the least that
 * gets a first attempt in the right shape.
 *
 * What this check answers is what the catalog and the product rules settle:
 * this mode exists, this model backs it, this value is one the control
 * offers, these characters fit, this line is one the canvas allows, this
 * panel can carry an upstream mention. How many nodes a shape takes, what
 * they are called, how many marks a prompt holds and how the nodes are wired
 * is the agent's to decide: a scene has more than one good answer, and a
 * check that picked one of them would be the rules written out in code.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  canConnect,
  effectiveItemCap,
  evaluateExecute,
  extractPromptText,
  feedersOf,
  nameableFeeders,
  GENERATION_NODE_MODES,
  PANEL_EDITOR_PARAM,
  promptPlainText,
  promptTextOf,
  referenceCapExceeded,
  type CanvasProposal,
  type CappedParam,
  type GenerationNodeType,
  type MaterialPath,
  type PromptSegment,
  type ProposalAnswer,
  type ProposalNode,
} from "@breatic/shared";

import {
  modelsForMode,
  type ModelInfo,
  type ParamInfo,
} from "@domain/model-catalog/mode-catalog.js";

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

/** Whether a proposal holds together, and what is missing when it does not. */
export type ProposalVerdict = { ok: true } | { ok: false; reason: string };

// Every string below that a card puts on screen is trimmed before it is
// measured: one made of spaces passes a length check and then draws a bullet
// with nothing beside it, or a mark naming nothing. The prompt's own text is
// the exception and is left alone -- a segment of one space is how two marks
// are kept apart, and trimming it would run them together.
const promptSegment = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z
    .object({
      slot: z
        .object({
          kind: z
            .enum(["asset", "tweak", "ref"])
            .describe(
              "asset: material the reader supplies in an empty node. " +
                "tweak: something only they can pick or write in the panel. " +
                "ref: names the node upstream, not a to-do",
            ),
          label: z.string().trim().min(1),
          note: z
            .string()
            .trim()
            .min(1)
            .describe("The line this puts on the card"),
        })
        .strict(),
    })
    .strict(),
]);

const proposalNode = z
  .object({
    role: z
      .enum(["source", "generate", "written"])
      .describe("written holds finished words; source is empty for the reader to fill"),
    type: z.enum([...NODE_TYPES, "text"]),
    name: z.string().trim().min(1).describe("What the reader sees on the node"),
    mode: z.string().min(1).optional().describe("role generate only"),
    model: z.string().min(1).optional().describe("role generate only"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "role generate only. Each value has to be one its control offers. " +
          "Leave out what a wired node, the vendor's list or the panel's own " +
          "box fills",
      ),
    prompt: z
      .array(promptSegment)
      .optional()
      .describe(
        "What to generate, or a written node's words. Mark what the reader " +
          "supplies or picks; the k-th asset mark pairs with the k-th empty " +
          "node wired in, the k-th ref mark with the k-th other, in the " +
          "order the nodes are listed",
      ),
  })
  .strict();

/**
 * What the tool accepts before any of the checks below run.
 *
 * Exported for the test that pins it: what the schema turns away never
 * reaches `checkProposal`, so the two halves of "a proposal the reader can
 * press" are held by one file and read by one test.
 */
export const inputSchema = z
  .object({
    nodes: z
      .array(proposalNode)
      .min(1)
      .describe("The nodes to place"),
    edges: z
      .array(
        z.object({ fromIndex: z.number().int(), toIndex: z.number().int() }).strict(),
      )
      .describe("Wiring inside this group; indices point into nodes"),
    modelNote: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What this model is for, and what it costs"),
    rationale: z.string().trim().min(1).describe("Why this shape, in a sentence or two"),
    groupName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What the group is for; needed once there are two nodes"),
  })
  .strict();

/**
 * The parameter a model fills from nodes wired into it, when it has one.
 *
 * Two gates turn on this answer -- whether an empty node has to be wired in
 * at all, and what a mark in the prompt lands as once the group is placed --
 * so it is given once.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @returns The pool parameter, or undefined when material arrives by slot.
 * @throws {never} Never.
 */
function poolParam(chosen: ModelInfo): ParamInfo | undefined {
  return Object.values(chosen.params).find((info) => info.fromReferencePool === true);
}

/**
 * What the catalog says about one proposed node, for everyone downstream.
 *
 * Answered here because the catalog is the authority and this file is the
 * only place that reads it. A node the catalog cannot place -- no mode, no
 * model, a model it does not carry -- is left unanswered, and the
 * per-generation check says what is wrong with it in its own words.
 * @param node - The proposed node.
 * @returns Its two facts, or undefined when the node generates nothing.
 * @throws {never} Never.
 */
function catalogFactsOf(
  node: ProposalNode,
): { takesFrom: MaterialPath; takesPrompt: boolean } | undefined {
  if (node.role !== "generate" || node.type === "text") return undefined;
  const { mode, model } = node;
  if (!mode || !model) return undefined;
  const reachable = modelsForMode(node.type, mode);
  if (!reachable.available) return undefined;
  const chosen = reachable.models.find((m) => m.name === model);
  if (!chosen) return undefined;
  return {
    takesFrom: poolParam(chosen) ? "pool" : "slot",
    takesPrompt: chosen.takesPrompt,
  };
}

/**
 * The same proposal with what the catalog says written onto each node.
 *
 * Done before anything is judged, not after: what a prompt may name is asked
 * of those two facts (`nameableFeeders`), so a check reading them off the node
 * and a canvas reading them off the same node cannot reach different answers.
 * @param proposal - What the model sent.
 * @returns The proposal as it will be placed.
 * @throws {never} Never.
 */
function withCatalogFacts(proposal: CanvasProposal): CanvasProposal {
  return {
    ...proposal,
    nodes: proposal.nodes.map((node) => {
      const facts = catalogFactsOf(node);
      return facts === undefined ? node : { ...node, ...facts };
    }),
  };
}

/**
 * A capped parameter in the words the shared cap rule reads it in.
 *
 * The catalog projects a parameter into camel case and the rule is stated on
 * the wire shape, so the two names for one fact meet here rather than the rule
 * being written a second time for this caller.
 * @param info - What the catalog says about the parameter.
 * @returns The same two fields, named the way the rule asks for them.
 * @throws {never} Never.
 */
function capShapeOf(info: ParamInfo): CappedParam {
  return {
    ...(info.maxItems === undefined ? {} : { max_items: info.maxItems }),
    ...(info.maxItemsWhen === undefined ? {} : { max_items_when_present: info.maxItemsWhen }),
  };
}

/**
 * Whether a parameter is one only the reader can fill, in the panel.
 *
 * Exported because three readings turn on it and they have to agree: a value
 * set here is refused, a control left to them has to be marked in the prompt,
 * and the fixtures build their proposals to match. Answered differently, the
 * model is told to leave a value out and never told to mark its place, and
 * the group lands with a control the reader must set and nothing saying so.
 * @param name - The parameter's name.
 * @param info - What the catalog says about it.
 * @returns True when the reader fills it once the group is placed.
 * @throws {never} Never.
 */
export function theirsToFill(name: string, info: ParamInfo): boolean {
  return info.valuesFrom !== undefined || name === PANEL_EDITOR_PARAM;
}

/**
 * Whether the panel will draw this control for the proposal as it stands.
 *
 * A control can hang on a switch of the same model: the camera wheels appear
 * once the camera is enabled and their values are thrown away until it is, and
 * the lyrics box goes away the moment the track is marked instrumental. The
 * switch is part of the proposal, so whether the reader will see the control is
 * answered here rather than by asking whether the model declares it. A gate on
 * a source is already settled by the projection, which reports a control with
 * no slot behind it as having no control at all.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @param params - What the proposal fills in.
 * @param info - What the catalog says about the parameter.
 * @returns True when the reader will have that control in front of them.
 * @throws {never} Never.
 */
function isDrawn(
  chosen: ModelInfo,
  params: Record<string, unknown>,
  info: ParamInfo,
): boolean {
  const gate = info.gate;
  if (gate === undefined || gate.kind === "source") return true;
  const held = params[gate.param];
  const on = typeof held === "boolean" ? held : chosen.params[gate.param]?.default === true;
  return gate.kind === "flagOn" ? on : !on;
}

/**
 * Judge the values a proposal filled in against what the model declares.
 *
 * The panel offers a control per parameter and that control is what a reader
 * would have used; a value it would not have offered is one that reaches the
 * upstream unchecked.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @param node - The node being judged.
 * @returns Whether every value stands, and which one does not.
 * @throws {never} Never.
 */
function checkParams(chosen: ModelInfo, node: ProposalNode): ProposalVerdict {
  const declared = Object.keys(chosen.params);
  for (const [key, value] of Object.entries(node.params ?? {})) {
    const info = chosen.params[key];
    if (!info) {
      return {
        ok: false,
        reason: `"${chosen.name}" declares no ${key}. It takes: ${declared.join(", ") || "no parameters"}.`,
      };
    }
    if (theirsToFill(key, info)) {
      return {
        ok: false,
        reason: info.valuesFrom !== undefined
          ? `"${key}" is picked from a list only ${info.valuesFrom} holds, so it cannot be written here. Leave it out and mark the choice in the prompt.`
          : `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. Leave it out and mark the place in the prompt.`,
      };
    }
    if (info.filledBySource === true) {
      // Two ways that material arrives, and the sentence names the one this
      // model uses: through the pool an edge carries it, through a slot the
      // reader clicks a node on the canvas. Said the other way round, it
      // sends the model off to wire an edge the panel never reads.
      return {
        ok: false,
        reason: info.fromReferencePool === true
          ? `"${key}" carries the reader's own material, which arrives by wiring an empty node in. Leave it out.`
          : `"${key}" carries the reader's own material, which they put in a slot on the panel. Leave it out.`,
      };
    }
    if (info.noControl === true) {
      return {
        ok: false,
        reason: `The panel draws no control for "${key}", so the reader can neither see it nor change it. Leave it out.`,
      };
    }
    if (!isDrawn(chosen, node.params ?? {}, info)) {
      const gate = info.gate as { kind: "flagOn" | "flagOff"; param: string };
      return {
        ok: false,
        reason: `"${key}" only counts while "${gate.param}" is ${gate.kind === "flagOn" ? "on" : "off"}, and this proposal leaves it the other way. Set that switch or leave "${key}" out.`,
      };
    }
    const options = info.options ?? [];
    if (options.length > 0 && !options.some((offered) => offered === value)) {
      return {
        ok: false,
        reason: `The control for "${key}" offers ${options.map((o) => JSON.stringify(o)).join(", ")}, not ${JSON.stringify(value)}.`,
      };
    }
    if (info.min === undefined && info.max === undefined) continue;
    if (typeof value !== "number") {
      return { ok: false, reason: `"${key}" takes a number, not ${JSON.stringify(value)}.` };
    }
    if ((info.min !== undefined && value < info.min) || (info.max !== undefined && value > info.max)) {
      return {
        ok: false,
        reason: `"${key}" runs from ${String(info.min ?? "?")} to ${String(info.max ?? "?")}, and this one is ${String(value)}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * The prompt as the panel will measure it once the group is placed.
 *
 * A mark pointing upstream writes no text of its own, and at Generate time
 * the body of the text node it names takes its place in the string the panel
 * measures (`serializePromptText`). Measured as nothing, a script past the
 * model's cap is placed and the reader meets the refusal at a button they
 * cannot fix from -- the words are in another node.
 *
 * A mark naming anything else substitutes nothing there either, so it counts
 * for nothing here.
 * @param prompt - The proposed prompt.
 * @param named - The nodes its marks point at, in the order they are marked.
 * @returns The text to measure against the model's cap.
 * @throws {never} Never.
 */
function measuredPrompt(
  prompt: readonly PromptSegment[],
  named: readonly (ProposalNode | null)[],
): string {
  let seen = 0;
  return prompt
    .map((segment) => {
      if (segment.slot?.kind !== "ref") return promptTextOf([segment]);
      const node = named[seen];
      seen += 1;
      return node?.role === "written" ? promptPlainText(node.prompt ?? []) : "";
    })
    .join("");
}

/**
 * Judge one generation node against the catalog and its own group.
 * @param proposal - The whole proposal, for reading the group around it.
 * @param node - The node being judged.
 * @param index - Where it sits, for naming it in a refusal.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
function checkGenerateNode(
  proposal: CanvasProposal,
  node: ProposalNode,
  index: number,
): ProposalVerdict {
  const { mode, model } = node;
  if (node.type === "text") {
    return {
      ok: false,
      reason: `"${node.name}" is a text node, and nothing is generated into one. Write the words yourself and send it as a written node.`,
    };
  }
  const nodeType: GenerationNodeType = node.type;
  if (!mode || !model) {
    return { ok: false, reason: `Node ${index} generates, so it needs a mode and a model.` };
  }
  // A mode this node never had and a mode no model here backs are the same
  // answer from the reader's side -- it cannot be proposed -- and
  // `modelsForMode` already names what the node does offer instead.
  const reachable = modelsForMode(nodeType, mode);
  if (!reachable.available) {
    return {
      ok: false,
      reason: reachable.offered.length > 0
        ? `No model here backs "${mode}" on a ${nodeType} node. It offers: ${reachable.offered.join(", ")}.`
        : `A ${nodeType} node can generate nothing right now.`,
    };
  }
  const chosen = reachable.models.find((m) => m.name === model);
  if (!chosen) {
    return {
      ok: false,
      reason: `"${model}" does not back "${mode}". Those that do: ${reachable.models.map((m) => m.name).join(", ")}.`,
    };
  }
  const values = checkParams(chosen, node);
  if (!values.ok) return values;

  const prompt = node.prompt ?? [];
  // Two ways the reader's material reaches a generation: the reference pool,
  // which an edge feeds, and a slot on the panel's toolbar, which the reader
  // fills by clicking any node of that kind anywhere on the canvas. Which one
  // this model uses is what it declares, carried here by the same projection
  // the agent is answered out of.
  //
  // Read before the prompt gate below, because what that gate measures
  // depends on which nodes this prompt can name.
  const pool = poolParam(chosen);
  // A model drawing no box mounts no editor and forces the box empty, so both
  // the words and a mark that lands as a mention of upstream work reach
  // nobody. Asked further down instead, the mention would be turned away for
  // the panel it cannot fit in, and the way out named there is words -- which
  // this same clause refuses. Material marks stay: they are what the card
  // draws its to-dos from, and the reader picks that material in a slot.
  const voidedHere = (segment: PromptSegment): boolean =>
    segment.slot === undefined || segment.slot.kind === "ref";
  if (!chosen.takesPrompt && prompt.some(voidedHere)) {
    return {
      ok: false,
      reason: `"${model}" draws no prompt box, so words written there and marks pointing upstream reach nobody. Keep the material marks and take the rest out.`,
    };
  }
  // The one reading of what feeds a node, shared with the card that files its
  // to-dos by it and the canvas that writes its mentions from it. A second
  // walk over the edges here is how the three come to disagree about which
  // node the k-th mark is about.
  const held = feedersOf(proposal, index);
  // What this prompt may name, by the one rule the canvas and the card read.
  const canName = nameableFeeders(proposal, index);
  /**
   * The nodes behind a run of feeder indices, in the proposal's own order.
   * @param list - The indices to resolve.
   * @returns One node per index.
   * @throws {never} Never.
   */
  const nodesAt = (list: readonly number[]): ProposalNode[] =>
    list.flatMap((i) => proposal.nodes[i] ?? []);
  // What each mark pointing upstream lands on, in the order the marks appear.
  // The k-th mark is about the k-th node wired in, so the pairing is settled
  // once here and read the same way by the gate below, the length it is
  // measured at, and the nodes a refusal names. Asked of the whole list of
  // feeders instead, each of those three answers a different question from
  // the one the canvas will act on.
  //
  // `null` where that mark lands on nothing: a place this panel would not
  // take a mention of, or no k-th feeder at all. A ref mark's mention IS its
  // text (`markText` answers with the empty string for it), so a mark landing
  // on nothing writes nothing -- the words on either side close up and the
  // sentence reaches the reader without what it was about.
  //
  // Asset marks are paired the same way and are left to the agent: that mark
  // carries its own bracketed text, so one with no source behind it still
  // names the slot to fill, which under the slot path is the whole
  // instruction there.
  const pointed = prompt
    .filter((segment) => segment.slot?.kind === "ref")
    .map((_, k) => canName.upstream[k])
    .map((i) => (i === undefined || i === null ? null : (proposal.nodes[i] ?? null)));
  // Four sentences because the way out differs, and a mark landing on nothing
  // leaves nothing on screen to work it out from: the reader is handed a
  // sentence missing what it was about, with no bracket and no gap to see.
  const lost = pointed.findIndex((n) => n === null);
  if (lost !== -1) {
    const wired = held.upstream.length;
    if (wired === 0 && held.sources.length === 0) {
      return {
        ok: false,
        reason: `"${node.name}" points at something upstream and nothing is wired into it. Wire an edge to what it draws on.`,
      };
    }
    if (wired === 0) {
      // An empty node is the place the reader fills, so it reaches the
      // generation through the panel's material slots rather than as upstream
      // work. The other mark is the one that names it.
      return {
        ok: false,
        reason: `"${node.name}" points at something upstream, and what is wired into it is material the reader fills in. Mark it as material, or wire in the work this draws on.`,
      };
    }
    if (lost >= wired) {
      return {
        ok: false,
        reason: `"${node.name}" points upstream ${String(pointed.length)} time(s) and ${String(wired)} node(s) are wired into it. Each mark is about one of them, in the order they are listed.`,
      };
    }
    return {
      ok: false,
      reason: `"${model}" cannot carry a mention of "${nodesAt(held.upstream)[lost]?.name ?? ""}". Say what you meant in the words themselves, and in your reply where the reader picks it up.`,
    };
  }
  // What the panel's own gate would say about the box this proposal fills in.
  // It is asked with the text the box will hold (`promptTextOf`), so the two
  // judge the same string; the sentences differ because this one is read by
  // the model that sent the proposal rather than by the reader.
  //
  // Imprecise in one direction, and only after this group is on the canvas: a
  // reference the reader @-mentions writes nothing into the text, so the
  // spaces around it collapse to one and the box holds a character less than
  // it looks. A prompt proposed at exactly the cap can therefore be refused
  // by a character once the reader mentions something in it (#268).
  // Measured once and reported from the same string: a sentence quoting the
  // unsubstituted length names a number below the cap it just refused on, and
  // tells the model to shorten a prompt that holds none of those characters.
  const measured = measuredPrompt(prompt, pointed);
  const verdict = evaluateExecute({
    promptText: measured,
    model,
    nodeStatus: "idle",
    isSubmitting: false,
    promptRequired: chosen.takesPrompt,
    ...(chosen.maxInputChars === undefined ? {} : { maxInputChars: chosen.maxInputChars }),
  });
  if (verdict?.refusal === "prompt-missing" || verdict?.refusal === "style-missing") {
    return {
      ok: false,
      reason: `"${model}" generates from what the prompt says, and this proposal writes nothing in it.`,
    };
  }
  if (verdict?.refusal === "prompt-too-long") {
    const written = [...extractPromptText(measured)].length;
    // The words are often in another node, and "shorten it" is not something
    // the model can act on until it knows which one.
    const holding = pointed
      .filter((n) => n?.role === "written")
      .map((n) => `"${n?.name ?? ""}"`);
    return {
      ok: false,
      reason: `"${model}" takes ${String(chosen.maxInputChars)} characters and this prompt is ${String(written)}${holding.length > 0 ? `, counting the words in ${holding.join(", ")}` : ""}. Shorten it, or propose a model that takes it.`,
    };
  }

  // The pool has a ceiling as well, stated by the model and enforced by the
  // panel by name, so a group placed over it is filled by the reader and then
  // turned away. Read through the one function the panel, the server and the
  // worker read, so the number is the same everywhere it is judged.
  //
  // What counts against it is what a mention will actually put there: the
  // panel counts the reference IMAGES the prompt mentions
  // (`mentionedReferenceUrls`), so a clip reaching the same generation, or the
  // words upstream, cannot be the node that puts this group over the line.
  const pooled = nodesAt([...held.sources, ...held.upstream]).filter(
    (n) => n.type === "image",
  );
  const cap = pool && effectiveItemCap(capShapeOf(pool), node.params ?? {});
  const over = pool ? referenceCapExceeded(pooled.length, cap) : null;
  if (over) {
    return {
      ok: false,
      reason: `"${model}" holds ${String(over.limit)} reference(s) at a time, and ${String(pooled.length)} node(s) reaching node ${String(index)} go in it.`,
    };
  }

  return { ok: true };
}

/**
 * Whether one node is the thing its role says it is.
 *
 * The three roles differ in what they carry, not only in what they are called:
 * an empty node holds nothing, a written one holds finished words and so can
 * only be a text node, and a generation is configured. A node whose role and
 * contents disagree lands on the canvas as something the reader cannot use.
 * @param node - The node being judged.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
function checkNodeRole(node: ProposalNode): ProposalVerdict {
  const configured =
    node.mode !== undefined || node.model !== undefined || node.params !== undefined;
  if (node.role === "source") {
    // Words are the one kind of material nobody has to go and find: an empty
    // text node is a click away, so proposing one asks for work rather than
    // saving any. Write the words instead, as a written node.
    if (node.type === "text") {
      return {
        ok: false,
        reason: `"${node.name}" is an empty text node, which the reader makes in one click. Write the words yourself and send it as a written node, or leave it out.`,
      };
    }
    if (configured || node.prompt !== undefined) {
      return {
        ok: false,
        reason: `"${node.name}" is an empty node for the reader to fill, so it takes no mode, model, parameters or prompt.`,
      };
    }
    return { ok: true };
  }
  if (node.role !== "written") return { ok: true };

  if (node.type !== "text") {
    return {
      ok: false,
      reason: `"${node.name}" carries words, and a text node is the only one that holds those.`,
    };
  }
  if (configured) {
    return {
      ok: false,
      reason: `"${node.name}" already holds its words, so it takes no mode and no model -- nothing is generated there.`,
    };
  }
  // Both marks that reach outside the words land as a mention, and a text
  // node's body holds none: one would ask for material nothing here reads,
  // the other would name a node nothing here looks at. Whatever they say
  // belongs in the message this proposal travels with.
  //
  // Asked before the words are measured: a mark pointing upstream writes no
  // characters, so a body made of one measures empty, and "carries no words"
  // sends the model off to add some while keeping the mark.
  const reaching = (node.prompt ?? []).find(
    (segment) => segment.slot?.kind === "asset" || segment.slot?.kind === "ref",
  );
  if (reaching) {
    return {
      ok: false,
      reason: `"${node.name}" holds words the reader keeps as they are, and nothing there reaches another node. Take the mark out and mention what you meant in your own message.`,
    };
  }
  // Without them it lands as an empty text node, which is the thing a reader
  // makes in a click and has no use for in a proposal.
  if (promptPlainText(node.prompt ?? []).trim() === "") {
    return { ok: false, reason: `"${node.name}" says it holds words and carries no words.` };
  }
  return { ok: true };
}

/**
 * Whether the edges lead anywhere, or run in a circle.
 *
 * An edge stands for one node drawing on another, so a ring of them says every
 * node waits on the next and the reader has nowhere to start.
 * @param proposal - What the model proposed.
 * @returns True when some edge leads back to where it started.
 * @throws {never} Never.
 */
function hasRing(proposal: CanvasProposal): boolean {
  const leadsTo = proposal.nodes.map<number[]>(() => []);
  for (const edge of proposal.edges) leadsTo[edge.fromIndex]?.push(edge.toIndex);
  // 0 not walked, 1 on the path being walked now, 2 walked and left behind.
  const state = proposal.nodes.map(() => 0);
  /**
   * Follow every edge out of one node, looking for the way back to it.
   * @param at - The node to walk from.
   * @returns True when this walk meets a node already on its own path.
   * @throws {never} Never.
   */
  const walk = (at: number): boolean => {
    if (state[at] === 1) return true;
    if (state[at] === 2) return false;
    state[at] = 1;
    for (const next of leadsTo[at] ?? []) {
      if (walk(next)) return true;
    }
    state[at] = 2;
    return false;
  };
  return proposal.nodes.some((_, at) => walk(at));
}

/**
 * Whether a proposal states a flow the reader can carry out.
 *
 * Pure, so the rule it applies is the one a test can hold: the catalog goes
 * in through `entriesForNode` and `modelsForMode`, and nothing else is read.
 *
 * Shape is the model's to decide -- one generation, one empty node feeding
 * three of them, words standing beside them -- within one bound: something
 * here generates. What is asked of every shape is that it states itself: each
 * node is what its role says, each edge stands for one node drawing on
 * another, and a group of two or more says what it is for.
 * @param sent - What the model proposed.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
export function checkProposal(sent: CanvasProposal): ProposalVerdict {
  return checkResolved(withCatalogFacts(sent));
}

/**
 * The same rules, over a proposal the catalog has already been read onto.
 *
 * Apart from {@link checkProposal} by that one step, so the answer the tool
 * hands back is the thing that was judged rather than a second reading of the
 * catalog taken after the verdict.
 * @param proposal - The proposal, carrying its catalog facts.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
function checkResolved(proposal: CanvasProposal): ProposalVerdict {
  for (const node of proposal.nodes) {
    const verdict = checkNodeRole(node);
    if (!verdict.ok) return verdict;
  }

  // A node earns its place on the canvas one of two ways: something generates
  // there, or it stands in a relation the reader would otherwise have to keep
  // in their head. Words with neither are words, and a reply carries those --
  // the reader reads them, takes them, and asks for another version in the
  // same breath, where placing, pressing and undoing buys them nothing.
  if (!proposal.nodes.some((node) => node.role === "generate")) {
    // The second sentence is about words, so it is said only where there are
    // words to say it about. On a group of empty nodes it would send the
    // model off to write copy nobody asked for.
    const words = proposal.nodes.some((node) => node.role === "written");
    return {
      ok: false,
      reason: words
        ? "Nothing here generates, so this is words the reader can read and take from your message. Write them in your reply instead."
        : "Nothing here generates, so a card placed from this leaves the reader nothing to press. Propose what gets made, or say in your reply what they should do.",
    };
  }

  for (const edge of proposal.edges) {
    const ends = [edge.fromIndex, edge.toIndex];
    if (ends.some((i) => i < 0 || i >= proposal.nodes.length)) {
      return { ok: false, reason: `An edge points outside the group: ${JSON.stringify(edge)}.` };
    }
    if (edge.fromIndex === edge.toIndex) {
      return { ok: false, reason: `An edge loops node ${edge.fromIndex} onto itself.` };
    }
    // An edge is how one node draws on another's material, so it can only end
    // where something reads it. Ending anywhere else, it is drawn on the canvas
    // saying a relation that nothing acts on.
    const into = proposal.nodes[edge.toIndex];
    const outOf = proposal.nodes[edge.fromIndex];
    if (into && into.role !== "generate") {
      return {
        ok: false,
        reason: `An edge flows into "${into.name}", which generates nothing, so nothing there reads what it carries.`,
      };
    }
    // The same whitelist the canvas holds a reader's own drag to. A line they
    // could not draw by hand is one the agent may not draw for them.
    if (into && outOf && !canConnect(outOf.type, into.type)) {
      return {
        ok: false,
        reason: `The canvas does not let a ${outOf.type} node feed a ${into.type} node, by your hand or theirs.`,
      };
    }
  }
  if (hasRing(proposal)) {
    return {
      ok: false,
      reason: "Those edges make a ring, and a ring says nothing about what the reader presses first.",
    };
  }

  // Two or more nodes land inside a group, which the reader sees as one thing
  // on a ground of its own. Only the model knows what that thing is for -- it
  // just decided -- so the name comes with the proposal.
  if (proposal.nodes.length > 1 && (proposal.groupName ?? "").trim() === "") {
    return {
      ok: false,
      reason: "Two or more nodes land together in a group, so give the group a name saying what it is for.",
    };
  }

  for (const [index, node] of proposal.nodes.entries()) {
    if (node.role !== "generate") continue;
    const verdict = checkGenerateNode(proposal, node, index);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * What the tool answers with: the proposal as it will be placed, or a refusal.
 *
 * Exported so a test can read the answer without standing up a tool call:
 * everything below `execute` is this function, and a test that reached it
 * through the SDK would be pinning the SDK's calling convention.
 * @param proposal - What the model sent.
 * @returns The answer the card and the canvas read.
 * @throws {never} Never.
 */
export function answerFor(proposal: CanvasProposal): ProposalAnswer {
  const resolved = withCatalogFacts(proposal);
  const verdict = checkResolved(resolved);
  if (!verdict.ok) return { placed: false, reason: verdict.reason };
  // The same resolution the check just judged against, so what the canvas
  // places is the thing that was judged. Asked again over there the catalog
  // could be absent -- the reader may press Use before it loads -- and a guess
  // either writes a mention the panel refuses or drops one the pool needs.
  return { ...resolved, placed: true };
}

/**
 * The one line the model reads back.
 *
 * The proposal itself is for the reader, not for the model -- it sent the
 * thing, and repeating it into every later turn costs the whole payload again.
 * @param answer - What the tool answered.
 * @returns A sentence saying it is on screen, or why it is not.
 */
export function renderProposalForModel(answer: ProposalAnswer): string {
  return answer.placed
    ? "The proposal is on screen as a card. The reader decides whether to place it."
    : `That proposal was refused, so nothing is on screen. ${answer.reason}`;
}

export const proposeCanvasAction: Tool<z.infer<typeof inputSchema>, ProposalAnswer> = tool({
  description:
    "Propose the canvas nodes for what the reader asked for, as a card they " +
    "place with one press. Something has to generate here: asked for words " +
    "and nothing else, write them in your reply instead. You decide the " +
    "shape: an empty node and a generation for a picture; the copy for the " +
    "same job as a written node beside them; one " +
    "empty node feeding several generations for several takes on one thing. " +
    "Before proposing any shape with an empty node in it, ask_user once " +
    "whether they have that material -- you cannot see their canvas, and the " +
    "answer decides the shape. Wire an edge where a node draws on another's " +
    "work or on what the reader puts in an empty node; belonging is said by " +
    "the group, not edges. " +
    "Ask get_canvas_capabilities and list_generation_models first, and " +
    "propose only a mode and model they returned. Fill in every setting you " +
    "can judge; the rest is theirs to run. Say in your reply, in numbered " +
    "steps, what they do once it is placed -- what to put in, what to pick, " +
    "what to press.",
  inputSchema,
  metadata: { runningLine: "chat.tool.proposingNodes" },
  toModelOutput: ({ output }) => ({ type: "text", value: renderProposalForModel(output) }),
  execute: async (
    proposal: z.infer<typeof inputSchema>,
    // Unused: reads a cached catalog and returns, so there is nothing to
    // abandon. Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<ProposalAnswer> => {
    return answerFor(proposal);
  },
});
