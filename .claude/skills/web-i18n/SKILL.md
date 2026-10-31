---
name: web-i18n
description: Use before adding or changing UI copy or keys in the root `locales/*.json`, writing ICU messages, translating product nouns that must stay in English (the do-not-translate list), labelling generation-panel controls and their values, or changing the language switcher, in packages/web or anywhere that renders those catalogs.
---

# Web i18n traps and details

The product nouns that never translate (the do-not-translate table), the rule that generation-panel value names stay in English, and the guards that enforce them are in the web package rules. This skill holds the details behind them.

## Message format

### ICU placeholders use single braces

**A placeholder in a locale message is `{name}`.** The catalogs are rendered with `intl-messageformat` (ICU); a Handlebars-style `{{name}}` is not a placeholder there and renders literally. Double braces are legitimate only where an ICU `select` or `plural` branch opens around a placeholder (`other {{role}}`), so when porting copy from another engine, read each `{{` rather than replacing them blindly.

### Locale edits need a dev restart

**After editing the root `locales/*.json`, restart the Vite dev server before checking the page.** The web package imports the catalogs through the `@locales` alias (`packages/web/src/i18n/locale-bootstrap.ts`) from outside its Vite root, and a running dev server has kept showing the old sentence after such edits while unit tests, which read the files from disk, pass. Check: the page disagrees with the locale file? See whether dev was started before the edit.

## The language switcher

### Language names stay native

**The language switcher labels each language with its own native name, which never changes with the interface language.** A reader who cannot read the current language must still find their own. The names are written once in `packages/web/src/features/preferences/supported-langs.ts` (`nativeName`) and are deliberate product data, not catalog entries.

## Do-not-translate details

How to apply the do-not-translate table when writing a sentence:

1. **Follow the English source's form.** A noun embedded in a sentence takes the number of the English key it comes from (EN `New project` gives `Project`, EN `Recent projects` gives `Projects`); the term is locked as written in the source, not forced to singular.
2. **Freeze only references to the entity or type.** The zh-CN `studio.container.projects.new` keeps `Project` in English inside the Chinese phrase, and a notification's word for a Studio entity is frozen too (including lower-case `studio`). ICU placeholders such as `{studio}` and `{project}` are variables and are never touched, and neither are URL paths such as `/studio/{slug}`.
3. **Canvas, Document and Agent are always the product's, so they are never translated.** The empty canvas, the infinite canvas and the agent panel all name ours, so `canvas.emptyState.title`, `spaces.kind.canvasSub` and `chrome.tooltip.agentHide` keep the English word in every language. Only a word that names something else stays translated: storage space (`server.mail.storage_full.subject`) is not a Space, and the focus-crop scrubber's time axis (`canvas.generatePanel.focusTimelineLabel`) is not a Timeline. Check: does the word point at something on our screen with that name? Then English.
4. **Two guards back this up.** repo-lint `no-translated-product-noun` (`repo-lint/src/product-noun-denylist.ts`) bans every translation that means nothing else; a translation that also has an ordinary meaning is frozen per key in `packages/web/src/i18n/__tests__/frozen-product-terms.test.ts` (`COLLISION_FROZEN`), so a new key with such a word needs a row there.

## Generation panel text

### Three kinds of panel text

The generation panel shows three kinds of text, each with its own source:

| Kind | Examples | Source | Languages |
|---|---|---|---|
| The panel's own text | Reset · On · Error · placeholder hints · Single / Dialogue | `locales/*.json` | All five |
| Control names (what is being set) | Quality · Horizontal angle · Camera position | locale keys such as `canvas.generatePanel.param.<param>` | All five |
| Value names (what was picked) | XHigh · Front · Low angle · Close-up · Pan left | the model YAML parameter's `value_labels` (an enum value or one step of a range); a camera command's `name` in `camera_commands` | English only, never in a locale |

The name of a group of values (camera movement: pan / tilt / dolly) answers "what is being set" and is a control name; each item in the group (Pan left) is a value.

### Why value names stay out of the catalogs

Value names are mostly industry terms that, like model names, are used in English anyway, and they belong to the model: putting them in the catalogs would mean five translations for every model added. **The one exception is language names**, which a parameter declares with `value_locales` (`packages/domain/src/model-catalog/param-declaration.ts`) so that `Intl` reads them out in the reader's language; never write those by hand.
