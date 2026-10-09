// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the values a proposal sets on a generation are ones the panel offers.
 */
import { PANEL_EDITOR_PARAM, type ControlGate, type ProposalNode } from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { refuse, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { boxReason, slotSentence, spaced } from "@domain/agent/tools/proposal-routing.js";
import type { ModelInfo, ParamInfo } from "@domain/model-catalog/mode-catalog.js";
import { onStep } from "@domain/model-catalog/param-declaration.js";

/**
 * Whether a parameter is one only the reader can fill, in the panel.
 *
 * Exported because two readings turn on it and they have to agree: a value
 * set here is refused, and the fixtures build their proposals to match.
 * Answered differently, a fixture the check would turn away is the thing the
 * cases are written against.
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
  if (gate === undefined) return true;
  const held = params[gate.param];
  return typeof held === "boolean" ? held : chosen.params[gate.param]?.default === true;
}

/** How many values a refusal lists before it falls back to the range and step. */
const LISTED_STEPS = 12;

/**
 * Why a number sits between two steps of its slider, or null when it is on one.
 *
 * The slider only stops on steps, so a value between two is one the panel
 * cannot show and, for a model that rounds, not the one it runs with.
 * @param key - The param name, quoted in the reason.
 * @param value - The number the proposal filled in, already within range.
 * @param info - The param as the catalog projects it.
 * @returns The reason, or null.
 */
function offStepReason(key: string, value: number, info: ParamInfo): string | null {
  const { min, max, step } = info;
  if (min === undefined || max === undefined || step === undefined || step <= 0) return null;
  if (onStep(value, min, step)) return null;
  const count = Math.floor((max - min) / step + 1e-9) + 1;
  const takes =
    count <= LISTED_STEPS
      ? Array.from({ length: count }, (_, i) => Number((min + i * step).toFixed(6))).join(", ")
      : `values from ${String(min)} to ${String(max)}`;
  return `"${key}" moves in steps of ${String(step)} from ${String(min)}, so it takes ${takes}, not ${String(value)}.`;
}

/**
 * The refusal for a parameter that something other than a value set here
 * fills: the node's shots, nothing at all, the reader in the panel, or a node
 * on the canvas. Undefined for a parameter a proposal sets itself.
 * @param chosen - The model.
 * @param node - The node.
 * @param key - The parameter's name.
 * @param info - What the catalog says about it.
 * @returns The refusal, or undefined.
 * @throws {never} Never.
 */
function placedElsewhere(chosen: ModelInfo, node: ProposalNode, key: string, info: ParamInfo): Refusal | undefined {
  if (info.fromStoryboard === true) {
    return chosen.storyboard === undefined
      ? refuse("param-storyboard-other-mode", `"${key}" is set by shots, which only the multi_shot mode takes. Leave it out.`)
      : refuse("param-storyboard", `"${key}" is set by the node's shots. Leave it out of params and give shots.`);
  }
  // Asked before anything that tells the agent how the reader fills a
  // value: a value the panel draws no control for is one nobody fills.
  if (info.noControl === true) {
    return refuse("param-no-control", `The panel draws no control for "${key}", so the reader can neither see it nor change it. Leave it out.`);
  }
  if (theirsToFill(key, info)) {
    return info.valuesFrom !== undefined
      ? refuse("param-from-list", `"${key}" is picked from a list only ${info.valuesFrom} holds, so it cannot be written here. Leave it out and add a note saying which one to pick.`)
      : refuse("param-box", boxReason(chosen, node, key));
  }
  if (info.filledBySource !== true) return undefined;
  // Two ways that material arrives, and the sentence names the one this
  // model uses: through the pool an edge carries it, through a slot the
  // reader clicks a node on the canvas. Said the other way round, it
  // sends the model off to wire an edge the panel never reads.
  // The catalog refuses a place on the canvas that names no kind it takes.
  const reached = spaced(slotSentence(chosen, node, info.accepts ?? "", info.fromReferencePool === true ? "pool" : key));
  return info.fromReferencePool === true
    ? refuse("param-pool", `"${key}" is the reference pool, which nodes reach and nothing set here does. Leave it out.${reached}`)
    : refuse("param-slot", `"${key}" is a slot for the reader's own material, which nodes reach and nothing set here does. Leave it out.${reached}`);
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
export function checkParams(chosen: ModelInfo, node: ProposalNode): ProposalVerdict {
  const settable = Object.entries(chosen.params).filter(([key, info]) => placedElsewhere(chosen, node, key, info) === undefined).map(([key]) => key);
  for (const [key, value] of Object.entries(node.params ?? {})) {
    const info = chosen.params[key];
    if (!info) {
      return refuse("param-undeclared", `"${chosen.name}" declares no ${key}. ${settable.length > 0 ? `The ones set here: ${settable.join(", ")}.` : "Nothing is set here."} Leave "${key}" out.`);
    }
    const elsewhere = placedElsewhere(chosen, node, key, info);
    if (elsewhere !== undefined) return elsewhere;
    if (!isDrawn(chosen, node.params ?? {}, info)) {
      const gate = info.gate as ControlGate;
      return refuse("param-gated-off", `"${key}" only counts while "${gate.param}" is on, and this proposal leaves it off. Set that switch or leave "${key}" out.`);
    }
    const options = info.options ?? [];
    if (options.length > 0 && !options.some((offered) => offered === value)) {
      return refuse("param-option", `The control for "${key}" offers ${options.map((o) => JSON.stringify(o)).join(", ")}, not ${JSON.stringify(value)}.`);
    }
    if (info.min === undefined && info.max === undefined) continue;
    if (typeof value !== "number") {
      return refuse("param-not-number", `"${key}" takes a number, not ${JSON.stringify(value)}.`);
    }
    if ((info.min !== undefined && value < info.min) || (info.max !== undefined && value > info.max)) {
      return refuse("param-out-of-range", `"${key}" runs from ${String(info.min ?? "?")} to ${String(info.max ?? "?")}, and this one is ${String(value)}.`);
    }
    const offStep = offStepReason(key, value, info);
    if (offStep !== null) return refuse("param-off-step", offStep);
  }
  return { ok: true };
}
