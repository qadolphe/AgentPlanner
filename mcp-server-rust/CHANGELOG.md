# Changelog

All notable changes to `pinksundew-mcp` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.6.0](https://github.com/pinksundew/pinksundew/compare/v2.5.0...v2.6.0) - 2026-05-10

### Added

- add support for Windsurf integration and refactor instruction handling
- update cursor rule syncing and management

### Other

- optimize instruction title extraction logic
- update synchronization timestamps and improve Kanban board functionality

## [2.5.0](https://github.com/pinksundew/pinksundew/compare/v2.4.0...v2.5.0) - 2026-04-20

### Added

- enhance agent instructions modal with context document handling

### Other

- update synchronization timestamps and enhance MCP client handling

## [2.4.0](https://github.com/pinksundew/pinksundew/compare/v2.3.0...v2.4.0) - 2026-04-18

### Added

- add architecture tab to MCP connection modal and remove redundant documentation files

### Other

- reformat CLI output code for improved readability and consistency

## [2.3.0](https://github.com/pinksundew/pinksundew/compare/v2.2.5...v2.3.0) - 2026-04-18

### Added

- add CLI setup tokens management

### Fixed

- simplify enabled_sync_targets function logic
- bump test

## [2.2.5](https://github.com/pinksundew/pinksundew/compare/v2.2.4...v2.2.5) - 2026-04-17

### Fixed

- thing
- resolve merge conflicts and update last synced timestamps in multiple files
- update last synced timestamps and MCP server instructions across multiple files

### Other

- Merge branch 'main' of https://github.com/pinksundew/pinksundew
- use dirs crate for cross-platform home directory resolution and update project documentation with security guidelines

## [2.2.4](https://github.com/pinksundew/pinksundew/compare/v2.2.3...v2.2.4) - 2026-04-17

### Changed

- rename MCP configuration environment variables to the Pink Sundew prefix

## [2.2.3](https://github.com/pinksundew/pinksundew/compare/v2.2.2...v2.2.3) - 2026-04-17

### Fixed

- point MCP update checks and install metadata at the Pink Sundew repository

## [2.2.2](https://github.com/pinksundew/pinksundew/compare/v2.2.1...v2.2.2) - 2026-04-17

### Fixed

- update greeting in README from 'Hi' to 'Hello'

## [2.2.1](https://github.com/pinksundew/pinksundew/compare/v2.2.0...v2.2.1) - 2026-04-17

### Fixed

- etest

## [2.2.0](https://github.com/pinksundew/pinksundew/compare/v2.1.6...v2.2.0) - 2026-04-17

### Added

- implement instruction sync targets and refactor client environment handling

### Other

- Remove MCP server files and configurations

## [2.1.6](https://github.com/pinksundew/pinksundew/releases/tag/v2.1.6) - 2026-04-17

### Added

- implement self-registering CLI for MCP configuration and update UI setup instructions

## [2.1.5](https://github.com/pinksundew/pinksundew/releases/tag/v2.1.5) - 2026-04-17

### Added

- Implement update service for checking and managing updates
- implement ToolService for project management and task handling

### Other

- add release configuration for pinksundew-mcp
- Bump pinksundew-mcp to 2.1.5
- Fix dist release tag path for Homebrew and wrapper fallback
- bump version to 2.1.3
- switch to standard tagging for homebrew compatibility
- correctly initialize cargo-dist at workspace root
- update last synced timestamp in AGENTS.md and refactor various functions in the MCP server
