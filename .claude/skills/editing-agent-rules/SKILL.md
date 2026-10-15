---
name: editing-agent-rules
description: Use before creating, editing, moving or deleting any agent rule file in this repository (the root AGENTS.md, a packages/<pkg>/AGENTS.md, any CLAUDE.md, or a project skill under .claude/skills/), before renaming a heading that code cites, and whenever you need to decide where a new rule, trap, convention or command should be written.
---

# Editing agent rules

Rules for coding agents live only in `AGENTS.md` files and project skills. Every `CLAUDE.md` holds the single line `@AGENTS.md`, because Claude Code reads `CLAUDE.md` and other agents read `AGENTS.md`; a rule written into `CLAUDE.md` is a second copy that drifts.

## Where each kind of content lives

| Content | Location | Loaded |
|---|---|---|
| Rules every contributor follows anywhere in the repository | root `AGENTS.md` | at session start |
| Rules and traps for one package | `packages/<pkg>/AGENTS.md`, with a `CLAUDE.md` beside it holding `@AGENTS.md` | when a file in that directory is read |
| Multi-step procedures and long detail needed for one kind of work | `.claude/skills/<name>/SKILL.md`; the matching `AGENTS.md` says "invoke `/<name>` before X" | when invoked |
| How something works: mechanisms, data flows, implementation detail | `docs/ARCHITECTURE.md` or a code comment; the rule says it in one sentence and links there | when the link is followed |
| Identity, personal ownership, private paths, personal tooling | the worktree's untracked `CLAUDE.local.md` | at session start, on that machine only |
| Decision history, quotes, dates, incident stories | commit message, PR body or issue | never |

- **One rule lives in one place.** Root and package files never repeat each other; a package file links the root heading instead.
- **Project rule files hold what is specific to this project: product rules (trust boundaries, business behaviour), architecture, conventions, languages, frameworks, commands and traps.** General working method that holds for any project (how to investigate, decide, design, review, test first or open PRs) is not written here.
- **A new trap goes into the matching package `AGENTS.md`, or the skill for that kind of work, as "when it breaks" plus "the correct way"; how it was found goes into the PR.**
- Check: would this hold for an external contributor on their first day? Yes → `AGENTS.md` or a skill. It concerns only maintainers' workflow, is personal or names private paths → the worktree's `CLAUDE.local.md` or the shared private file, never a tracked file.
- Check: is this a constraint that must hold, or a description of how something works? Constraint → `AGENTS.md` (the rule, its red line and a `Check:`). How it works → `docs/ARCHITECTURE.md`, linked from the rule, never copied into it.

## What to write

| Kind | Form |
|---|---|
| Rule | one to three sentences: a bold statement of what must be true, then one sentence of why |
| Trap | when it breaks and the correct way; optionally one wrong line and one right line |
| Command | only commands a model could not guess, such as `pnpm db:journal-add <NNNN_name>` |
| Link | every link says when to read it |
| Decision question | a single `Check:` line |

- **A rule that code or docs cite gets its own heading with a short, stable English title.** Every citation, in skills too, is written `<repo-root path>#<anchor>` or as a relative markdown link with an anchor; a bare root path means the root file (`AGENTS.md#rule-files`) and package files are written in full (`packages/web/AGENTS.md#every-scroller-is-a-scrollarea`). The anchor is the heading lower-cased, punctuation dropped, spaces turned into hyphens.
- **Renaming or deleting a cited heading updates every citation in the same PR.** Find them by searching the repository for the old anchor before you rename; repo-lint `agent-rule-files` fails on any citation whose heading is gone.
- **Link to another rule file by relative path, and to a skill as "invoke `/<name>`" plus a relative link to its `SKILL.md`.**

## What not to write

| Never write | Why |
|---|---|
| quotes, decision records, dates, incident stories | they belong in commits, PRs and issues, and they rot |
| person names, agent names, team division | rule files describe the project, not who works on it |
| the private repository's name or paths into it | the repository is public; `inner#N` is the only allowed pointer |
| absolute local paths, references to personal memory files | no other reader can open them |
| internal metrics, pricing, business strategy, customer names | not public information |
| secrets, accounts | never in a tracked file |
| general knowledge the model already has | it costs context and changes nothing |

## Length

- **Every `AGENTS.md` stays within 200 lines; `agent-rule-files` enforces it.** Past that, move what is needed only for one kind of work into a project skill and link it; never drop a rule to fit.
- Check, before keeping a line: without it, would the model make a mistake? No → delete it.

## Language

**Rule files and skills are written in English.** This is a global source-available project, and `no-cjk` scans every `AGENTS.md` and `.claude/skills/**/*.md`.

## Maintenance

- **Rule files change through PRs and are reviewed like code.**
- **What a lint, test or hook can enforce is enforced that way, not written as a rule;** once a check exists, the rule shrinks to one sentence naming it.
- **Prune rules that no longer apply or that a check now enforces.**
- **`CLAUDE.md` holds exactly `@AGENTS.md` and a newline, and every `AGENTS.md` has that `CLAUDE.md` beside it;** without it Claude Code never loads the directory's rules.
- **Keep rules inside the repository.** A file outside the working directory that carries `paths` frontmatter is never loaded, and an `@` import inside a `.claude/rules/` file expands at session start whatever its `paths` say.
- **Under `.claude/`, only `.claude/skills/` is tracked (`.gitignore`: `.claude/*` then `!.claude/skills/`);** everything else there stays on each machine.
- **A project skill is `.claude/skills/<name>/SKILL.md` with frontmatter `name: <name>` and a one-paragraph `description` that says exactly when to use it;** the agent decides to invoke it from that description alone. Long detail goes in extra `.md` files in the same directory, each linked from `SKILL.md` with when to read it.

## Before you finish

```bash
wc -l AGENTS.md packages/*/AGENTS.md
pnpm lint:repo agent-rule-files
pnpm lint:repo no-cjk
pnpm lint:repo no-private-repo-path
```
