# Security

## Reporting a vulnerability

If you discover a security vulnerability in this package, please:

1. Open a private [GitHub security advisory](https://github.com/syrokomskyi/changelog-live/security/advisories/new), or
2. Contact the maintainer via [GitHub profile](https://github.com/syrokomskyi).

Please **do not** open a public issue for security-related problems.

## Response timeline

- Acknowledgement: within 48 hours
- Initial assessment: within 7 days
- Fix or mitigation: depends on severity, typically within 30 days for high-severity issues

## Scope

This package processes git history and sends commit messages to LLM providers (OpenAI, Anthropic, Gemini). Be aware that:

- Commit messages are sent to external AI APIs for changelog generation
- No source code is sent — only commit messages and metadata
- API keys are read from environment variables and never logged or persisted
- The `.env` file is auto-loaded from the git repo root but never committed

## Out of scope

- Vulnerabilities in third-party AI provider APIs
- Issues arising from custom prompt configurations that leak sensitive data
- Problems in downstream consumers of the generated changelog files
