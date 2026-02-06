# Claude Code Plugin Marketplace Structure

Research findings on Claude Code local plugin marketplace configuration and structure.

## Overview

Claude Code supports local plugin marketplaces that can be registered either:
1. Via `extraKnownMarketplaces` in `~/.claude/settings.json`
2. Via entries in `~/.claude/plugins/known_marketplaces.json`

## 1. marketplace.json Structure

Location: `<marketplace-root>/.claude-plugin/marketplace.json`

### Minimal Example (Skills-only marketplace)

```json
{
  "name": "anthropic-agent-skills",
  "owner": {
    "name": "Keith Lazuka",
    "email": "klazuka@anthropic.com"
  },
  "metadata": {
    "description": "Anthropic example skills",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "example-skills",
      "description": "Collection of example skills",
      "source": "./",
      "strict": false,
      "skills": [
        "./skill-creator",
        "./mcp-builder"
      ]
    }
  ]
}
```

### Full Example (With LSP servers)

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "local-marketplace",
  "description": "Local plugin marketplace for custom extensions",
  "owner": {
    "name": "Local",
    "email": "local@localhost"
  },
  "plugins": [
    {
      "name": "tailwindcss-lsp",
      "description": "Tailwind CSS language server for intelligent class suggestions",
      "version": "1.2.0",
      "author": {
        "name": "Local",
        "email": "local@localhost"
      },
      "source": "./plugins/tailwindcss-lsp",
      "category": "development",
      "strict": false,
      "lspServers": {
        "tailwindcss": {
          "command": "tailwind-lsp-adapter",
          "args": ["--stdio"],
          "extensionToLanguage": {
            ".css": "css",
            ".html": "html",
            ".jsx": "javascriptreact",
            ".tsx": "typescriptreact"
          }
        }
      }
    }
  ]
}
```

### Plugin Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Plugin identifier (used in enabledPlugins) |
| `description` | Yes | Human-readable description |
| `source` | Yes | Relative path to plugin directory, or source object for remote |
| `version` | No | Semantic version string |
| `author` | No | Object with `name` and `email` |
| `category` | No | Category: development, productivity, security, learning, etc. |
| `homepage` | No | URL to plugin homepage/docs |
| `strict` | No | Whether plugin runs in strict mode |
| `tags` | No | Array of string tags (e.g., "community-managed") |
| `skills` | No | Array of relative paths to skill directories |
| `lspServers` | No | Object mapping LSP server names to configurations |

### LSP Server Configuration

```json
{
  "lspServers": {
    "server-name": {
      "command": "executable-name",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ext": "language-id"
      },
      "startupTimeout": 120000
    }
  }
}
```

### Remote Source Types

Plugins can reference remote sources instead of local paths:

```json
{
  "source": {
    "source": "url",
    "url": "https://github.com/org/repo.git"
  }
}
```

## 2. known_marketplaces.json Format

Location: `~/.claude/plugins/known_marketplaces.json`

This file tracks all registered marketplaces with their source and install location.

### Structure

```json
{
  "marketplace-name": {
    "source": {
      "source": "directory",
      "path": "/absolute/path/to/marketplace"
    },
    "installLocation": "/absolute/path/to/marketplace",
    "lastUpdated": "2026-02-05T15:12:57.746Z"
  }
}
```

### Source Types

**Local directory:**
```json
{
  "source": {
    "source": "directory",
    "path": "/Users/max/.claude/plugins/local-marketplace"
  }
}
```

**GitHub repository:**
```json
{
  "source": {
    "source": "github",
    "repo": "anthropics/claude-plugins-official"
  }
}
```

## 3. extraKnownMarketplaces in settings.json

Location: `~/.claude/settings.json`

### Structure

```json
{
  "extraKnownMarketplaces": {
    "marketplace-name": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/marketplace"
      }
    }
  }
}
```

### Enabling Plugins

Plugins are enabled via the `enabledPlugins` object:

```json
{
  "enabledPlugins": {
    "plugin-name@marketplace-name": true
  }
}
```

Example:
```json
{
  "enabledPlugins": {
    "tailwindcss-lsp@local-marketplace": true,
    "typescript-lsp@claude-plugins-official": true
  }
}
```

## 4. Directory Structure

### Marketplace Root

```
marketplace-root/
├── .claude-plugin/
│   └── marketplace.json       # Required: marketplace definition
└── plugins/
    └── plugin-name/
        └── (plugin files)
```

### Individual Plugin Structure

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json            # Optional: plugin metadata
├── .mcp.json                  # Optional: MCP server configuration
├── README.md                  # Optional: documentation
├── skills/
│   └── skill-name/
│       └── SKILL.md           # Skill definition with frontmatter
├── commands/
│   └── command-name.md        # Slash command definition
└── hooks/
    ├── hooks.json             # Hook configuration
    └── hook_script.py         # Hook implementation
```

### plugin.json (Individual Plugin)

Minimal metadata for the plugin itself:

```json
{
  "name": "plugin-name",
  "description": "Plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com"
  }
}
```

## 5. Skills Structure

Location: `plugin-root/skills/<skill-name>/SKILL.md`

### SKILL.md Format

```markdown
---
name: skill-name
description: This skill should be used when the user asks to "phrase1", "phrase2", or discusses topic-area.
version: 1.0.0
---

# Skill Title

Skill content in markdown...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier |
| `description` | Yes | Trigger conditions - when Claude should use this skill |
| `version` | No | Semantic version |
| `license` | No | License information |

## 6. Commands Structure

Location: `plugin-root/commands/<command-name>.md`

### Command Format

```markdown
---
description: Short description shown in /help
argument-hint: <required-arg> [optional-arg]
allowed-tools: [Read, Glob, Grep, Bash]
model: haiku
---

# Command Title

Command instructions...

User arguments: $ARGUMENTS
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Shown in /help output |
| `argument-hint` | No | Hint for command arguments |
| `allowed-tools` | No | Pre-approved tools (reduces permission prompts) |
| `model` | No | Override model (haiku, sonnet, opus) |

## 7. Hooks Structure

Location: `plugin-root/hooks/hooks.json`

### hooks.json Format

```json
{
  "description": "Hook description",
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/script.py"
          }
        ],
        "matcher": "Edit|Write|MultiEdit"
      }
    ]
  }
}
```

### Hook Types

- `PreToolUse` - Before tool execution
- `PostToolUse` - After tool execution

### Variables

- `${CLAUDE_PLUGIN_ROOT}` - Path to plugin root directory

## 8. MCP Server Configuration

Location: `plugin-root/.mcp.json`

### Format

```json
{
  "server-name": {
    "type": "http",
    "url": "https://mcp.example.com/api"
  }
}
```

or for stdio:

```json
{
  "server-name": {
    "type": "stdio",
    "command": "executable",
    "args": ["--arg1"]
  }
}
```

## 9. Complete Local Marketplace Setup

### Step 1: Create Directory Structure

```
~/.claude/plugins/local-marketplace/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── my-plugin/
        ├── .claude-plugin/
        │   └── plugin.json
        └── README.md
```

### Step 2: Create marketplace.json

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "local-marketplace",
  "description": "My local plugins",
  "owner": {
    "name": "Local",
    "email": "local@localhost"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "My custom plugin",
      "source": "./plugins/my-plugin",
      "category": "development"
    }
  ]
}
```

### Step 3: Register in known_marketplaces.json

Add to `~/.claude/plugins/known_marketplaces.json`:

```json
{
  "local-marketplace": {
    "source": {
      "source": "directory",
      "path": "/Users/<username>/.claude/plugins/local-marketplace"
    },
    "installLocation": "/Users/<username>/.claude/plugins/local-marketplace",
    "lastUpdated": "2026-02-06T00:00:00.000Z"
  }
}
```

### Step 4: Enable Plugin

Add to `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "my-plugin@local-marketplace": true
  }
}
```

## 10. Key Findings

1. **marketplace.json location**: Must be in `.claude-plugin/marketplace.json` subdirectory
2. **Plugin sources**: Can be relative paths (`./plugins/name`) or source objects for remote repos
3. **LSP in marketplace.json**: LSP servers are defined in the marketplace.json plugin entry, not in separate plugin.json
4. **Individual plugin.json**: Optional, contains minimal metadata (name, description, author)
5. **Enabling plugins**: Format is `plugin-name@marketplace-name`
6. **Directory-based sources**: Use `"source": "directory"` with absolute `"path"`
7. **GitHub sources**: Use `"source": "github"` with `"repo": "owner/repo"`
