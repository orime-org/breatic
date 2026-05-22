/**
 * Node-only loader for locale JSON files. Kept on its own subpath
 * (`@breatic/shared/i18n-node`) so the web bundle never has to follow
 * `node:fs` / `node:path` imports — see `feedback_shared_barrel_browser_pull`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { setLocaleMessages } from "./index.js";

/**
 * Load all locale JSON files from `localesDir` and register them with
 * the shared i18n engine. Defaults to the repo-root `locales/` directory
 * resolved relative to this file's location in `node_modules`.
 *
 * Server entry points should call this once at boot, before any `t()`
 * call runs.
 */
export function loadLocales(localesDir?: string): void {
  const dir = localesDir ?? resolve(import.meta.dirname, "../../../../locales");
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const locale = basename(file, ".json");
      const raw = readFileSync(resolve(dir, file), "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      setLocaleMessages(locale, data);
    }
  } catch {
    // locales dir may not exist in test environments
  }
}
