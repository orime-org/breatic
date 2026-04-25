---
name: skill_creator
description: "Create or update Breatic Skills. Use when designing, structuring, or packaging skills with scripts, references, and assets."
---

# Skill Creator

Skills are modular, self-contained packages that extend the agent's capabilities. Think of them as "onboarding guides" for specific domains—they transform the agent from a general-purpose assistant into a specialist equipped with procedural knowledge no model can fully possess.

## Core Principles

### Concise is Key

The context window is a public good. Skills share it with everything else: system prompt, conversation history, and the actual user request.

**Default assumption: the agent is already very smart.** Only add context the agent doesn't already have. Challenge each piece: "Does the agent really need this?" Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match specificity to the task's fragility:

- **High freedom** (prose instructions): multiple valid approaches, context-dependent decisions
- **Medium freedom** (pseudocode with parameters): preferred pattern, some variation acceptable
- **Low freedom** (exact scripts): fragile operations, consistency critical, fixed sequence required

### Anatomy of a Skill

```
skill-name/
├── SKILL.md              (required) — frontmatter(name+description) + Markdown instructions
├── package.json          (required) — runtime config: tools, category, output_type, keywords, requires
├── _meta.json            (optional) — publish metadata: author, version, license, publishedAt
└── Bundled resources     (optional)
    ├── scripts/          Executable code (Python/Bash/etc.)
    ├── references/       Documentation loaded into context on demand
    └── assets/           Files used in output (templates, icons, fonts)
```

**`scripts/`** — When the same code is rewritten repeatedly or deterministic reliability is needed. Can be executed without loading into context.

**`references/`** — Reference material loaded as needed. Use for: DB schemas, API docs, domain knowledge, company policies. If files are large (>10k words), include grep patterns in SKILL.md.

**`assets/`** — Files used in output, not loaded into context: templates, images, boilerplate code.

Do NOT add: README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, or any auxiliary documentation.

## Progressive Disclosure Design

Skills use three loading levels:
1. **Frontmatter** (`name` + `description`) — always in context (~100 words)
2. **SKILL.md body** — loaded when skill triggers (<500 lines)
3. **Bundled resources** — loaded on demand by the agent

Keep SKILL.md body under 500 lines. When splitting into reference files, always link them from SKILL.md with clear guidance on when to read them.

**Pattern 1: High-level guide with references**
```markdown
## Advanced features
- **Form filling**: See references/forms.md for complete guide
- **API reference**: See references/api.md for all methods
```

**Pattern 2: Domain-specific organization**
```
analytics-skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── revenue.md
    ├── users.md
    └── marketing.md
```
Agent reads only the relevant domain file.

**Pattern 3: Conditional details**
```markdown
For simple edits, modify directly.
**For tracked changes**: See references/redlining.md
```

Guidelines: keep references one level deep; add table of contents for files over 100 lines.

## Skill Creation Process

1. Understand the skill with concrete examples
2. Plan reusable contents (scripts, references, assets)
3. Create the skill directory and write SKILL.md
4. Add bundled resources; test all scripts by running them
5. Save via the skill API
6. Iterate based on real usage

### Skill Naming

- Lowercase letters, digits, underscores only (e.g., `image_editor`, `gh_review`)
- Under 64 characters
- Prefer short, verb-led phrases
- Namespace by tool when helpful: `gh_address_comments`, `linear_triage`
- Name the skill directory exactly after the skill name

### Writing SKILL.md

#### SKILL.md Frontmatter

Only two fields — `name` and `description`:
- `name`: the skill name (lowercase, underscores)
- `description`: **primary triggering mechanism** — include what the skill does AND all "when to use" triggers. Everything here is always in context; the body is not.

```yaml
---
name: my_skill
description: "What it does and when to use it."
---
```

#### package.json

Runtime configuration. Required alongside SKILL.md:

```json
{
  "name": "my_skill",
  "description": "What it does and when to use it.",
  "tools": ["run_script", "read_file"],
  "output_type": "canvas",
  "category": "image",
  "keywords": ["image", "ai"],
  "requires": {
    "env": ["MY_API_KEY"],
    "bins": ["ffmpeg"]
  },
  "always": false,
  "disable_model_invocation": false,
  "user_invocable": true
}
```

Fields: `tools` (list of tool names), `category` ("image"|"text"|"video"|"audio"|"3d"|"web"|"default"), `output_type` ("canvas"|"inline"), `requires.env`/`requires.bins` (dependencies).

#### _meta.json (optional)

Publish metadata. Not used at runtime:

```json
{
  "ownerId": "your-owner-id",
  "slug": "my_skill",
  "version": "1.0.0",
  "publishedAt": 1769911642173
}
```

#### Body

- Use imperative/infinitive form
- Put all "when to use" information in `description`, not the body
- Link reference files with explicit "read when X" instructions
- Include concrete examples rather than verbose explanations
