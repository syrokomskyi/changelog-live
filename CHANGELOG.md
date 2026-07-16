# Changelog

All notable changes to the `changelog-live` project are documented here.

## 2026-07-09 .. 2026-07-15

### Added
- Add @syrokomskyi/changelog-live package and integrate it into the HDRI export workflow and image app.
- Add changelog-live integration to image app with support to auto-load .env from git root in CLI.
- Implement discovery of cross-tree renames in changelog-live when initializing and updating configs.
- Add ability for changelog-live to prune redundant subpaths and ancestor paths from trace output.
- Move changelog configuration to per-project YAML files and introduce a prebuild hook.

### Changed
- Replace em-dash with '..' in changelog-live week headers for improved readability.
- Improve changelog-live parse regex to make square brackets optional for backward compatibility.
- Remove square brackets from changelog date headers in changelog-live.

### Fixed
- Remove dead prebuild task and address code review findings in changelog-live.
- Remove backward compatibility for bracketed dates in changelog-live regex.

### Removed
- Remove redundant changelog files from the HDRI app.

### Documentation
- Document changelog-live init subcommand and add package to AGENTS.md.
