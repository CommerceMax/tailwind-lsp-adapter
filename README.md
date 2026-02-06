# tailwind-lsp-adapter

[![npm version](https://img.shields.io/npm/v/tailwind-lsp-adapter.svg)](https://www.npmjs.com/package/tailwind-lsp-adapter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/tailwind-lsp-adapter.svg)](https://nodejs.org)

LSP adapter for [@tailwindcss/language-server](https://github.com/tailwindlabs/tailwindcss-intellisense) that enables compatibility with [Claude Code](https://claude.ai/code).

## Why?

Claude Code's LSP client doesn't support several protocol methods that the Tailwind CSS Language Server requires:

- `client/registerCapability` — dynamic capability registration
- `workspace/configuration` — server requests workspace settings
- `window/workDoneProgress/create` — progress reporting

Without this adapter, the Tailwind CSS Language Server fails to initialize because it relies on dynamic registration to set up completions, hover, and diagnostics.

## Architecture

```
Claude Code  ←→  tailwind-lsp-adapter  ←→  @tailwindcss/language-server
                        ↓
                 Intercepts and handles:
                 - client/registerCapability
                 - client/unregisterCapability
                 - workspace/configuration
                 - window/workDoneProgress/create
                 - $/progress notifications
```

The adapter is a transparent stdio proxy. It:
1. Patches the `initialize` request to advertise dynamic registration support
2. Intercepts server→client requests that Claude Code can't handle
3. Responds to them on behalf of Claude Code
4. Forwards everything else unchanged

## Installation

### Quick Install (Recommended)

```bash
# 1. Install dependencies
npm install -g @tailwindcss/language-server tailwind-lsp-adapter

# 2. Run automated setup
tailwind-lsp-adapter --setup

# 3. Enable LSP tools (add to ~/.zshrc or ~/.bashrc)
echo 'export ENABLE_LSP_TOOL=1' >> ~/.zshrc
source ~/.zshrc

# 4. Restart Claude Code and install the plugin
#    In Claude Code, run:
#    /plugin install tailwind-lsp-adapter@local-plugins
```

The `--setup` command automatically:
- Creates the plugin structure in `~/.claude/plugins/`
- Registers the local marketplace
- Updates Claude Code settings

### Manual Installation

<details>
<summary>Click to expand manual installation steps</summary>

**Step 1.** Create the plugin structure:

```bash
mkdir -p ~/.claude/plugins/tailwind-lsp-adapter/.claude-plugin

cat > ~/.claude/plugins/tailwind-lsp-adapter/.claude-plugin/plugin.json << 'EOF'
{
  "name": "tailwind-lsp-adapter",
  "description": "Tailwind CSS language support via tailwind-lsp-adapter",
  "version": "1.0.0"
}
EOF

cat > ~/.claude/plugins/tailwind-lsp-adapter/.lsp.json << 'EOF'
{
  "tailwindcss": {
    "command": "tailwind-lsp-adapter",
    "extensionToLanguage": {
      ".css": "css",
      ".scss": "scss",
      ".html": "html",
      ".jsx": "javascriptreact",
      ".tsx": "typescriptreact",
      ".vue": "vue",
      ".svelte": "svelte",
      ".astro": "astro",
      ".php": "php"
    }
  }
}
EOF
```

**Step 2.** Register the plugin in a local marketplace:

```bash
mkdir -p ~/.claude/plugins/.claude-plugin

cat > ~/.claude/plugins/.claude-plugin/marketplace.json << 'EOF'
{
  "name": "local-plugins",
  "owner": { "name": "local" },
  "plugins": [
    {
      "name": "tailwind-lsp-adapter",
      "source": "./tailwind-lsp-adapter",
      "description": "Tailwind CSS language support via tailwind-lsp-adapter"
    }
  ]
}
EOF
```

**Step 3.** Add the marketplace to Claude Code settings (`~/.claude/settings.json`):

```json
{
  "extraKnownMarketplaces": {
    "local-plugins": {
      "source": {
        "source": "directory",
        "path": "~/.claude/plugins"
      }
    }
  }
}
```

**Step 4.** Install the plugin in Claude Code:

```
/plugin install tailwind-lsp-adapter@local-plugins
```

**Step 5.** Enable LSP tools and restart:

```bash
echo 'export ENABLE_LSP_TOOL=1' >> ~/.zshrc
source ~/.zshrc
```

</details>

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TAILWIND_LSP_COMMAND` | Override the language server command (default: `tailwindcss-language-server`) |
| `TAILWIND_LSP_ARGS` | Override server arguments (default: `--stdio`) |
| `LSP_ADAPTER_DEBUG` | Set to `1` to enable debug logging |

### Debug Logging

To troubleshoot issues, enable debug logging in your `.lsp.json`:

```json
{
  "tailwindcss": {
    "command": "tailwind-lsp-adapter",
    "extensionToLanguage": {
      ".css": "css",
      ".tsx": "typescriptreact"
    },
    "env": {
      "LSP_ADAPTER_DEBUG": "1"
    }
  }
}
```

Logs are written to:
- **macOS/Linux:** `/tmp/tailwind-lsp-adapter.log`
- **Windows:** `%TEMP%\tailwind-lsp-adapter.log`

## Supported LSP Features

Once installed, Claude Code gains Tailwind CSS intelligence:

- **Diagnostics** — errors and warnings after edits (invalid classes, conflicting utilities)
- **Hover** — full CSS output preview for Tailwind classes

## Limitations

Claude Code's LSP client has limited protocol support compared to full IDEs like VS Code. The following features are **not available** even with this adapter:

| Feature | Status | Reason |
|---------|--------|--------|
| Completions | Not supported | Claude Code doesn't request completions from LSP servers |
| Color decorators | Not supported | Claude Code doesn't process `textDocument/documentColor` |
| Code Actions | Not supported | Claude Code doesn't request code actions |
| Go to Definition | Not supported | Claude Code doesn't use `textDocument/definition` |
| Document Links | Not supported | Claude Code doesn't process document links |

This adapter enables the Tailwind CSS Language Server to **initialize successfully** and provide the features that Claude Code does support (diagnostics and hover). For full Tailwind CSS IntelliSense, use VS Code or another editor with complete LSP support.

## Tailwind CSS v4 Support

The adapter automatically detects Tailwind v4 projects that use the new CSS-first configuration.

### How It Works

1. **Auto-detection**: When initializing, the adapter searches for CSS files containing `@import "tailwindcss"` or `@import 'tailwindcss'`
2. **Priority order**: Prefers common entry points (`src/index.css`, `src/app.css`, `src/styles.css`)
3. **Configuration**: Sets `experimental.configFile` to enable v4 language server features

### Manual Override

If auto-detection doesn't find your entry point, set the environment variable:

```bash
export TAILWIND_CSS_ENTRYPOINT="src/styles/main.css"
```

### Supported Patterns

| Pattern | Example |
|---------|---------|
| CSS Import | `@import "tailwindcss";` |
| CSS Import (single quotes) | `@import 'tailwindcss';` |

## How It Works

The adapter sits between Claude Code and the Tailwind CSS Language Server as a transparent stdio proxy:

1. **On `initialize`**: Patches the client capabilities to advertise `dynamicRegistration: true` for all relevant features, plus `workspace.configuration` and `window.workDoneProgress` support.

2. **On `client/registerCapability`**: Accepts the registration, stores it internally, and sends a success response back to the server. Claude Code never sees this request.

3. **On `workspace/configuration`**: Returns sensible Tailwind CSS defaults (class attributes, lint settings, etc.) so the server can configure itself.

4. **On `window/workDoneProgress/create`**: Accepts the progress token silently.

5. **On `$/progress` and `window/logMessage`**: Absorbs these notifications to prevent Claude Code from receiving messages it can't process.

6. **Everything else**: Passed through unchanged in both directions.

## Building from Source

```bash
git clone https://github.com/CommerceMax/tailwind-lsp-adapter.git
cd tailwind-lsp-adapter
npm install
npm run build

# Test locally
node dist/index.js
```

## Security

The adapter implements several security measures:

- **Command validation**: Only allows `tailwindcss-language-server` as the LSP command
- **Path validation**: Prevents access to system directories (`/etc`, `/usr`, etc.)
- **Safe execution**: Uses `execFileSync` with array arguments (no shell interpolation)
- **Secure logging**: Debug logs use unique filenames with restrictive permissions (0600)

## Related Issues

- [Claude Code #16360](https://github.com/anthropics/claude-code/issues/16360) — Missing LSP protocol handlers (workspace/configuration, client/registerCapability, window/workDoneProgress/create)
- [Agasper/CSharpLspAdapter](https://github.com/Agasper/CSharpLspAdapter) — Inspiration: same pattern for C# LSP
- [Helix #4986](https://github.com/helix-editor/helix/discussions/4986) — Tailwind CSS LSP dynamic registration issues in other editors

## License

MIT
