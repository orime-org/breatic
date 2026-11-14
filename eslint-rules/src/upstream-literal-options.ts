// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** One upstream as `config/provider/upstreams.yaml` declares it, as far as the rule reads it. */
interface UpstreamDecl {
  base_url: string;
  key_env: string;
}

/** Sites an upstream is reached at besides its API's own host. */
const OTHER_HOSTS = ["fal.ai"];

/**
 * What `breatic/no-upstream-literal` guards, read from provider's upstream file so a new upstream is guarded without
 * touching the rule: each upstream's name and key variable, and the host of its API without an `api.` or `queue.`
 * label, so another endpoint of the same vendor is caught too.
 * @param root The repository root.
 * @returns The rule's options.
 */
export function upstreamLiteralOptions(root: string): { hosts: string[]; names: string[] } {
  const { upstreams } = parse(readFileSync(join(root, "config/provider/upstreams.yaml"), "utf8")) as {
    upstreams: Record<string, UpstreamDecl>;
  };
  const decls = Object.entries(upstreams);
  return {
    hosts: [...new Set([...decls.map(([, d]) => new URL(d.base_url).hostname.replace(/^(api|queue)\./, "")), ...OTHER_HOSTS])],
    names: [...new Set(decls.flatMap(([name, d]) => [name, d.key_env]))],
  };
}
