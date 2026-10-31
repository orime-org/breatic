// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Explicit executor dependencies; the HTTP service and loop share one runtime.
 */
import { env, createR2MaintenanceStorage, type MaintenanceConfig, type MaintenanceStorage, type MaintenanceAvailability } from "@breatic/core";
import { getMaintenanceConfig } from "@server/config/maintenance.js";
export interface MaintenanceDependencies {
  storage: MaintenanceStorage;
  config: MaintenanceConfig;
  now: () => Date;
}
let override: MaintenanceDependencies | null = null;
let physical: MaintenanceStorage | null = null;

/**
 * Whether actual credentials and execution configuration permit physical work.
 * @returns Distinct configured/enabled/available flags.
 */
export function maintenanceAvailability(): MaintenanceAvailability {
  const enabled = (override?.config ?? getMaintenanceConfig()).enabled;
  const configured = override !== null || Boolean(env.R2_BUCKET && env.R2_ACCESS_KEY && env.R2_SECRET_KEY && env.R2_S3_ENDPOINT && env.UPLOAD_BASE_URL);
  return {
    enabled, configured, available: enabled && configured
  };
}

/**
 * Read production dependencies lazily, never exposing credential values.
 * @returns Runtime executor dependencies.
 * @throws {Error} When direct R2 operations are not configured.
 */
export function getMaintenanceDependencies(): MaintenanceDependencies {
  if (override)
    return override;
  const config = getMaintenanceConfig();
  physical ??= createR2MaintenanceStorage(config.storageTimeoutMs);
  return {
    storage: physical, config, now: () => new Date()
  };
}

/**
 * Install a deterministic storage port while exercising the real service/SQL/HTTP.
 * @param dependencies - Explicit fixture runtime.
 */
export function setMaintenanceDependenciesForTest(dependencies: MaintenanceDependencies): void {
  override = dependencies;
}

/**
 * Restore production dependencies after a fixture.
 */
export function resetMaintenanceDependenciesForTest(): void {
  override = null;
}

/**
 * Read settings without requiring storage credentials.
 * @returns Current settings.
 */
export function maintenanceConfig(): MaintenanceConfig {
  return override?.config ?? getMaintenanceConfig();
}

/**
 * Read the deterministic or wall clock without constructing a storage client.
 * @returns Current instant.
 */
export function maintenanceNow(): Date {
  return override?.now() ?? new Date();
}

/** Release the production physical client after the executor has drained. */
export function closeMaintenanceStorage():void {physical?.close?.();physical=null;}
