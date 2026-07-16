# @syrokomskyi/changelog-live

AI-powered CHANGELOG.md generator that collects git history, groups changes by configurable periods (default: weekly, starting Thursday), and produces professional changelog entries using LLMs.

## Features

- Collects git commits from any path(s) in a repository
- Groups changes by week (configurable start day, default Thursday)
- AI-generated professional changelog entries (OpenAI, Anthropic, Gemini)
- Multi-language support with 100% sync between translations
- Incremental updates — only processes new commits since last entry
- Completed weeks only — in-progress (current) weeks are never written; re-running on the same week is idempotent
- `init` subcommand — auto-discovers all historical git paths via rename tracing
- CLI + library API
- YAML configuration file

## Quick start

```bash
# Initialize: discover all git history paths and create changelog.config.yaml
npx @syrokomskyi/changelog-live init

# Generate changelog from existing config
npx @syrokomskyi/changelog-live --config changelog.config.yaml

# Using library
import { generateChangelog } from "@syrokomskyi/changelog-live";

await generateChangelog({
  git: { repoRoot: ".", subPath: "src" },
  grouping: { period: "week", startDay: "thu" },
  languages: { primary: "en", translations: ["de"] },
  ai: {
    generation: { provider: "openai", model: "gpt-4.1" },
    translation: { provider: "openai", model: "gpt-4.1" },
  },
  output: { dir: ".", filename: "CHANGELOG" },
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

## Configuration

Create a `changelog.config.yaml`:

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
```

## API keys

Set environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
