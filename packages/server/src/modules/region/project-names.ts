// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Project names for pages the global region serves (inner#1955): each
 * Project's name is read in the region it lives in, this region's own from
 * this database.
 */

import { env, logger, studioDirectoryRepo } from "@breatic/core";
import { t } from "@breatic/shared";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { askRegion } from "@server/modules/region/fanout.js";

/**
 * The names of these Projects in this region's database.
 * @param projectIds - The Projects.
 * @returns Name by id, for the ones found.
 */
export async function projectNamesHere(projectIds: string[]): Promise<Record<string, string>> {
  const identities = await projectRepo.getIdentitiesByProjectIds(projectIds);
  return Object.fromEntries([...identities].map(([id, identity]) => [id, identity.name]));
}

/**
 * The names of Projects in any region; a region that does not answer leaves
 * its Projects unnamed.
 * @param projectIds - The Projects.
 * @returns Name by id, for the ones found.
 */
export async function projectNamesEverywhere(projectIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return {};
  // A Project the directory does not place yet is looked for here: this
  // region writes its own Projects' directory rows with them, so only
  // another region's newest Projects can be missing, and those read as unnamed.
  const homeOf = new Map(unique.map((id) => [id, env.REGION]));
  for (const { projectId, region } of await studioDirectoryRepo.listProjectRegions(unique)) {
    homeOf.set(projectId, region ?? env.GLOBAL_REGION);
  }
  const byRegion = new Map<string, string[]>();
  for (const [projectId, home] of homeOf) byRegion.set(home, [...(byRegion.get(home) ?? []), projectId]);
  const parts = await Promise.all(
    [...byRegion].map(async ([region, ids]) => {
      if (region === env.REGION) return projectNamesHere(ids);
      try {
        return await askRegion<Record<string, string>>(region, "projectNames", [ids], t("server.region.unavailable"));
      } catch (err) {
        logger.error({ err, ctx: { region, projects: ids.length } }, "project_names_region_unavailable");
        return {};
      }
    }),
  );
  return Object.assign({}, ...parts) as Record<string, string>;
}
