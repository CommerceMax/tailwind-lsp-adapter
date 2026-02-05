# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-05

### Added
- Initial release of tailwind-lsp-adapter
- Transparent proxy between Claude Code and @tailwindcss/language-server
- Automatic handling of unsupported LSP methods:
  - `client/registerCapability` - dynamic capability registration
  - `client/unregisterCapability` - capability removal
  - `workspace/configuration` - workspace settings with Tailwind defaults
  - `window/workDoneProgress/create` - progress token acceptance
  - `$/progress` - progress notification absorption
  - `window/logMessage` - log message handling
- Tailwind CSS v4 auto-detection for CSS-first configuration
  - Automatically finds CSS files with `@import "tailwindcss"`
  - Sets `experimental.configFile` for v4 projects
  - Supports `TAILWIND_CSS_ENTRYPOINT` env var override
- Initialize request patching for dynamic registration support
- Debug logging via `LSP_ADAPTER_DEBUG=1` environment variable
- Zero runtime dependencies (Node.js built-ins only)

### Security
- Input validation for workspace paths (prevents path traversal)
- Server command validation (allowlist for tailwindcss-language-server)
- Safe command execution using execFileSync (no shell interpolation)
- Secure log file permissions (mode 0600)
- Unique log filenames to prevent information disclosure

### Technical Details
- TypeScript strict mode enabled
- ES2022 target with Node18 module resolution
- MIT license
- Supports Node.js 18.0.0 and above
