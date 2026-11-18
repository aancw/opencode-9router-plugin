# Changelog

All notable changes to this project are documented in this file.

This repository is a fork of
[`mdhb2/opencode-9router-plugin`](https://github.com/mdhb2/opencode-9router-plugin)
by [@mdhb2](https://github.com/mdhb2). Versions `0.1.0` through `0.2.0` are
upstream work, reproduced here for context. `0.2.1` is the first change in this
fork.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-18 — this fork

First release from this fork, built on top of upstream `0.2.0`.

### Added

- **Thinking variants** (OpenCode v2) on reasoning-capable models. `#low`,
  `#medium`, `#high`, … select an effort level; the plugin maps it to opencode's
  `reasoningEffort`, which reaches the request as the standard `reasoning_effort`
  body param. Gated by the live catalog (`capabilities.reasoning` +
  `thinking_levels`), with a model-id heuristic fallback for bare-id gateways.
- **Full model metadata mapping** (v2): context window and max-output limits,
  per-million-token pricing (including cache read/write), tools, vision
  (`input: image`) and pdf input capabilities.
- **Loopback relay fallback** (v2): when the opencode process is denied
  local-network access (for example on macOS), fetch the catalog out-of-process
  via curl and route chat traffic through a small `127.0.0.1` node relay, so
  model listing and streaming both keep working.
- `scripts/harness.mjs`: a dev harness that loads the built `dist/index.js`
  against a mock opencode context.
- Streaming `/chat/completions` endpoint in the mock 9router server, logging the
  received `reasoning_effort` and `temperature`.

### Changed

- Dependency `@opencode/plugin` `^2.0.16` → `^2.3.0`.
- README: thinking-variant docs, relay/environment notes, and troubleshooting.

### Environment

- New optional `OPENCODE_9ROUTER_NODE`: absolute path to a node binary used by
  the loopback relay. Otherwise the plugin probes `node` on `PATH`, a login
  shell `PATH`, common install locations, and `~/.nvm/versions/node/*`.

## [0.2.0] - 2026-09-25 — upstream

### Added

- OpenCode v2 support via a dual entrypoint: v2 registers provider `9router`
  through `ctx.provider.transform` with `@opencode/ai/providers/openai-compatible`,
  while v1 keeps the legacy `config` hook with `@ai-sdk/openai-compatible`.
- `scripts/mock-9router.mjs`, a mock `/models` server for local development.

### Changed

- Installer/check CLI updated for the v1 + v2 dual entrypoint.

## [0.1.4] - 2026-05-22 — upstream

### Changed

- README and packaging asset/version updates.

## [0.1.3] - 2026-05-22 — upstream

### Changed

- README: add GitHub repository link; asset and version updates.

## [0.1.2] - 2026-05-22 — upstream

### Changed

- README cover image; asset and version updates.

## [0.1.1] - 2026-05-22 — upstream

### Added

- Installer/check CLI (`src/cli.ts`).
- Plugin cover image asset.

### Changed

- README rework.

## [0.1.0] - 2026-05-22 — upstream

### Added

- Initial `opencode-9router-plugin` package: dynamic 9router provider discovery
  for opencode, so model lists no longer need to be hardcoded in config.
