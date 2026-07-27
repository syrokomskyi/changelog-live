# @wgogol/changelog-live

AI-powered CHANGELOG.md generator that collects git history, groups changes by configurable periods (default: weekly, starting Thursday), and produces professional changelog entries using LLMs.

## Features

- Collects git commits from any path(s) in a repository
- Groups changes by week (configurable start day, default Thursday)
- AI-generated professional changelog entries (OpenAI, Anthropic, Gemini)
- Multi-language support with 100% sync between translations
- Incremental updates — only processes new commits since last entry
- Completed weeks only — in-progress (current) weeks are never written; re-running on the same week is idempotent
- **Public changelog** — optional `CHANGELOG_PUBLIC.md` with client-facing categories, AI-generated titles, and summaries (independent incremental flow)
- `init` subcommand — auto-discovers all historical git paths via rename tracing
- CLI + library API
- YAML configuration file

## Quick start (standalone)

```bash
# Initialize: discover all git history paths and create changelog.config.yaml
changelog-live init

# Generate changelog from existing config
changelog-live --config changelog.config.yaml
```

## Quick start (in this Turborepo)

Every workspace project that has a `changelog.config.yaml` includes two npm scripts:

```bash
# Generate CHANGELOG.md for a single project
pnpm --filter @syrokomskyi/site run changelog

# Initialize changelog.config.yaml in a single project
pnpm --filter @syrokomskyi/site run changelog:init

# Generate changelogs across ALL projects in the monorepo
pnpm changelog

# Initialize changelog configs across ALL projects
pnpm changelog:init
```

Both `pnpm changelog` and `pnpm changelog:init` run through Turborepo (`pnpm turbo run changelog` / `changelog:init`), so they execute in parallel with correct dependency ordering.

### How it works

1. **`changelog:init`** — runs `changelog-live init` in each project directory. Auto-discovers all historical git paths via `git log --follow` rename tracing and writes `changelog.config.yaml`. Skips projects that already have a config file. Reads defaults from `changelog.config.default.yaml` at the repo root.

2. **`changelog`** — runs `changelog-live` in each project directory. Reads `changelog.config.yaml`, collects git commits since the last CHANGELOG entry, groups by completed weeks, sends to an LLM for professional formatting, and writes `CHANGELOG.md` (plus translations). Idempotent: re-running on the same week produces no changes.

### Adding changelog to a new project

```bash
cd apps/gen/my-new-project
pnpm --filter @syrokomskyi/my-new-project run changelog:init
```

This creates `changelog.config.yaml`. Then:

```bash
pnpm --filter @syrokomskyi/my-new-project run changelog
```

The `@wgogol/changelog-live` devDependency and both scripts are added automatically when `changelog.config.yaml` is present in the project.

## Configuration

```yaml
git:
  paths:
    - apps/my-project
grouping:
  period: week
  startDay: thu
languages:
  primary: de
  translations:
    - en
    - uk
ai:
  generation:
    provider: openai
    model: gpt-4.1
  translation:
    provider: openai
    model: gpt-4.1
output:
  dir: .
  filename: CHANGELOG
maxHistoryWeeks: 2
sortOrder: desc
publicChangelog: false
```

### `publicChangelog`

When set to `true`, the tool generates an additional `CHANGELOG_PUBLIC.md` alongside the internal `CHANGELOG.md`. This is a client-facing changelog with:

- **Separate categories**: Added, Improved, Fixed, Security & Compliance, Integrations (instead of the internal Keep a Changelog categories)
- **AI-generated title** with date range (e.g. `Plattform-Updates für die Woche 2026-07-10 — 2026-07-17`)
- **Summary paragraph** (2–3 sentences) written by a senior technical writer prompt
- **Independent incremental flow** — reads `CHANGELOG_PUBLIC.md` to determine last entry, collects commits, and generates sections regardless of internal changelog state
- **Translations** — `CHANGELOG_PUBLIC.{lang}.md` files generated for each configured translation language
- **Escalating retry** — up to 3 attempts if the AI title lacks the required date range

The public changelog uses the same `ai.generation` provider and model as the internal changelog. No `commitMessage` is generated from the public call (the internal call provides it for export workflows).

## API keys

Set environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. The CLI auto-loads `.env` from the git repo root.

## Library API

```ts
import { generateChangelog } from "@wgogol/changelog-live";

await generateChangelog({
  git: { repoRoot: ".", subPath: "src" },
  grouping: { period: "week", startDay: "thu" },
  languages: { primary: "en", translations: ["de"] },
  ai: {
    generation: { provider: "openai", model: "gpt-4.1" },
    translation: { provider: "openai", model: "gpt-4.1" },
  },
  output: { dir: ".", filename: "CHANGELOG" },
  publicChangelog: true,
});
```

## `init` subcommand

`changelog-live init` discovers all historical git paths for the current working directory and creates `changelog.config.yaml`. It:

1. Detects the git repo root and CWD's relative position via `git rev-parse`.
2. Collects seed paths: CWD + all visible first-level subdirectories (excludes hidden `.`-prefixed and `-`-prefixed dirs).
3. For each seed, finds a seed file and traces its full rename history via `git log --follow --name-status`.
4. Extracts all directories where the file ever lived, including ancestor directories.
5. Recursively traces historical directories to catch files that existed in old paths but were deleted before renames.
6. Writes `changelog.config.yaml` with all discovered paths and default settings.

The `init` command reads `changelog.config.default.yaml` from the repo root (or nearest ancestor) for default settings. If missing, it falls back to built-in defaults and prints a message. Skips initialization if `changelog.config.yaml` already exists.
