# Contributing to tailwind-lsp-adapter

Thank you for your interest in contributing to the Tailwind LSP Adapter!

## Development Setup

### Prerequisites

- Node.js 18.0.0 or higher
- npm 8.0.0 or higher
- @tailwindcss/language-server installed globally

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/CommerceMax/tailwind-lsp-adapter.git
   cd tailwind-lsp-adapter
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Link for local testing:
   ```bash
   npm link
   ```

### Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run dev` | Watch mode for development |
| `npm run clean` | Remove build artifacts |
| `npm run typecheck` | Type-check without emitting |

## Testing Locally

1. Enable debug logging:
   ```bash
   export LSP_ADAPTER_DEBUG=1
   ```

2. Check the log file for debugging:
   ```bash
   tail -f /tmp/tailwind-lsp-adapter-*.log
   ```

3. Test with Claude Code by configuring the plugin.

## Making Changes

### Code Style

- TypeScript strict mode is enabled
- Use explicit types for function parameters and returns
- Avoid `any` types - use proper interfaces
- Keep functions focused and under 50 lines
- Add JSDoc comments for public functions

### Security Guidelines

- Never use `execSync` or `exec` with string interpolation
- Always use `execFileSync` with array arguments
- Validate all external inputs (env vars, LSP messages)
- Never log sensitive data (file contents, credentials)

### Commit Messages

Use conventional commit format:

```
type(scope): description

feat: add new feature
fix: fix a bug
docs: update documentation
refactor: code refactoring
test: add tests
chore: maintenance tasks
security: security improvements
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes with clear commits
4. Ensure the build passes: `npm run build`
5. Update documentation if needed
6. Submit a pull request with a clear description

## Reporting Issues

When reporting issues, please include:

- Node.js version (`node --version`)
- @tailwindcss/language-server version
- Operating system
- Debug logs (with `LSP_ADAPTER_DEBUG=1`)
- Steps to reproduce

## Code of Conduct

Be respectful and constructive in all interactions. We're all here to build something useful together.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
