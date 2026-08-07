# @warpgogol/changelog-live

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![CI](https://img.shields.io/github/actions/workflow/status/syrokomskyi/changelog-live/ci.yml?logo=github-actions&logoColor=white)](https://github.com/syrokomskyi/changelog-live/actions) [![npm](https://img.shields.io/npm/v/@warpgogol/changelog-live?logo=npm&logoColor=white)](https://www.npmjs.com/package/@warpgogol/changelog-live)

AI-powered CHANGELOG.md generator that collects git history, groups changes by configurable periods (default: weekly, starting Thursday), and produces professional changelog entries using LLMs.

## Features

- Collects git commits from any path(s) in a repository
- Groups changes by configurable periods (week, biweekly, month, day)
- AI-generated professional changelog entries (OpenAI, Anthropic, Gemini)
- Multi-language support with 100% sync between translations
- Incremental updates — only processes new commits since last entry
- Completed periods only — in-progress periods are never written; re-running is idempotent
- **CLI period control** — `--since`, `--until`, `--since-tag`, `--until-tag`, `--force` for manual period control
- **Commit filtering** — exclude merge commits, bot authors, and message patterns via config or `--no-merges` CLI flag
- **Public changelog** — optional `CHANGELOG_PUBLIC.md` with client-facing categories, AI-generated titles, and summaries (independent incremental flow)
- `init` subcommand — auto-discovers all historical git paths via rename tracing
- CLI + library API
- YAML configuration file

## Quick start

```bash
# Install
npm install -g @warpgogol/changelog-live

# Initialize: discover all git history paths and create changelog.config.yaml
changelog-live init

# Generate changelog from existing config
changelog-live --config changelog.config.yaml
```

Or use without global install:

```bash
npx @warpgogol/changelog-live init
npx @warpgogol/changelog-live --config changelog.config.yaml
```

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
    systemPrompt: |
      You are a technical writer for a fintech startup...
      Use a casual but professional tone.
      Group changes into: Features, Bug Fixes, Infrastructure.
  translation:
    provider: openai
    model: gpt-4.1
    systemPrompt: |
      You are a professional translator specializing in fintech terminology...
output:
  dir: .
  filename: CHANGELOG
filter:
  excludeMerges: false
  excludeAuthors:
    - dependabot[bot]
    - renovate[bot]
  excludePatterns:
    - "^chore\\(deps\\):"
    - "^ci:"
maxHistoryPeriods: 2
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

### Custom AI prompts

Both `ai.generation` and `ai.translation` accept an optional `systemPrompt` field. When provided, it replaces the built-in system prompt for that function. When omitted, the built-in prompt is used.

- **`ai.generation.systemPrompt`** — replaces the built-in prompt for both internal and public changelog generation. The custom prompt must instruct the AI to return the same JSON structure (categories + commitMessage for internal; title + summary + categories for public).
- **`ai.translation.systemPrompt`** — replaces the built-in translation prompt. The custom prompt must instruct the AI to return only translated markdown without preamble.

Language, period dates, and commit data are passed in the user prompt (formed by code), not in the system prompt. This keeps the system prompt static and reusable across runs.

### Commit filtering

The optional `filter` section controls which commits are included in changelog generation:

- **`excludeMerges`** (default: `false`) — when `true`, merge commits are excluded via `git log --no-merges`.
- **`excludeAuthors`** (default: `[]`) — a list of author names to exclude. Commits whose `author` matches any entry are filtered out.
- **`excludePatterns`** (default: `[]`) — a list of regex patterns tested against commit messages. Commits whose message matches any pattern are filtered out.

The CLI `--no-merges` flag is a shorthand for `filter.excludeMerges: true`. When both the config and the CLI flag are set, the CLI flag takes priority.

```bash
# Exclude merge commits via CLI
changelog-live --no-merges
```

## API keys

Set environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.

### Automatic `.env` loading

The CLI **automatically loads `.env` files** — no manual `source .env`, `--env-file`, or `dotenv` setup is needed. The loading order is:

1. **Git repo root `.env`** — found via `git rev-parse --show-toplevel`, loaded with `process.loadEnvFile()`.
2. **CWD `.env`** — loaded second, so it takes priority over the repo root `.env` if both exist.

If neither file exists or no API key is found, the CLI throws with a clear error message indicating which environment variable to set.

```bash
# Just run — .env is auto-loaded from the repo root
changelog-live

# Or set the key inline if you prefer
OPENAI_API_KEY=sk-... changelog-live
```

## Library API

```ts
import { generateChangelog } from "@warpgogol/changelog-live";

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

## CLI flags

The `changelog-live` CLI accepts the following options:

| Flag                  | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `-c, --config <path>` | Path to `changelog.config.yaml` (default: `changelog.config.yaml`) |
| `--since <date>`      | Collect commits since this date (YYYY-MM-DD)                       |
| `--until <date>`      | Collect commits until this date (YYYY-MM-DD)                       |
| `--since-tag <tag>`   | Resolve git tag to date and use as `--since`                       |
| `--until-tag <tag>`   | Resolve git tag to date and use as `--until`                       |
| `--force`             | Regenerate existing periods (in-progress periods still skipped)    |
| `--no-merges`         | Exclude merge commits                                              |
| `--dry-run`           | Run without writing files (output to stdout)                       |
| `--verbose`           | Show detailed output (commits, AI prompts, timing)                 |
| `--quiet`             | Suppress all output except errors                                  |
| `--provider <name>`   | Override AI provider (openai, anthropic, gemini)                   |
| `--model <name>`      | Override AI model                                                  |
| `--output <path>`     | Override output directory or file path                             |

### Period control

- `--since` / `--until` limit the commit collection period to specific dates (YYYY-MM-DD).
- `--since-tag` / `--until-tag` resolve git tags to dates via `git log -1 --format=%ad --date=short <tag>`, then use them as `--since` / `--until`.
- `--force` regenerates existing changelog periods. In-progress periods are still skipped (safe default). This is useful when AI generated poor text and you want to regenerate.
- CLI flags take priority over auto-detected `sinceDate` from the existing CHANGELOG.

```bash
# Generate changelog for a specific date range
changelog-live --since 2026-07-01 --until 2026-07-31

# Use git tags as period boundaries
changelog-live --since-tag v1.0.0 --until-tag v2.0.0

# Force regenerate all existing periods
changelog-live --force
```

## `init` subcommand

`changelog-live init` discovers all historical git paths for the current working directory and creates `changelog.config.yaml`. It:

1. Detects the git repo root and CWD's relative position via `git rev-parse`.
2. Collects seed paths: CWD + all visible first-level subdirectories (excludes hidden `.`-prefixed and `-`-prefixed dirs).
3. For each seed, finds a seed file and traces its full rename history via `git log --follow --name-status`.
4. Extracts all directories where the file ever lived, including ancestor directories.
5. Recursively traces historical directories to catch files that existed in old paths but were deleted before renames.
6. Writes `changelog.config.yaml` with all discovered paths and default settings.

The `init` command reads `changelog.config.default.yaml` from the repo root (or nearest ancestor) for default settings. If missing, it falls back to built-in defaults and prints a message. Skips initialization if `changelog.config.yaml` already exists — use `--force` (or `-f`) to overwrite the existing config:

```bash
changelog-live init --force
```

## Running in a monorepo

When multiple packages or apps each have their own `changelog.config.yaml`, the CLI resolves `git.repoRoot` and `output.dir` relative to the **config file's directory**, not the current working directory. This means you can run the CLI from anywhere and point it at any config:

```bash
# Both work identically:
cd apps/hdri && changelog-live
changelog-live --config apps/hdri/changelog.config.yaml
```

### Batch regeneration script

To regenerate changelogs across all packages and apps in a monorepo:

```bash
#!/bin/bash
set -euo pipefail

CLI="$(git rev-parse --show-toplevel)/packages/changelog-live/src/cli.ts"

find . -name "changelog.config.yaml" -not -path "./node_modules/*" | while read -r cfg; do
  echo "=== $cfg ==="
  pnpm exec tsx "$CLI" --config "$cfg" || echo "FAILED: $cfg"
done
```

### Key points for agents

- **Paths resolve from the config file** — `repoRoot` and `output.dir` in `changelog.config.yaml` are relative to the config file's directory, not CWD. No need to `cd` into each package.
- **Retry on `Connection error`** — OpenAI rate limits can cause transient failures. Wait a few seconds and re-run failed configs.
- **`.env` is auto-loaded** — no need to `source .env` or set `OPENAI_API_KEY` manually; the CLI loads `.env` from the git repo root automatically.
- **Idempotent** — re-running skips periods already covered. Use `--force` to regenerate existing periods.

## Changelog

[CHANGELOG.md](CHANGELOG.md)
