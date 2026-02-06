# Plugin Installation Automation Research

## Executive Summary

**Recommendation: Hybrid Approach - CLI Command + Documentation**

After thorough research into Claude Code's plugin system, npm security best practices, and existing plugin installation patterns, the recommended approach is to provide a **dedicated CLI command** (`npx tailwind-lsp-adapter setup`) rather than a postinstall script. This balances user experience with security and follows established patterns in the ecosystem.

---

## Current Manual Installation Process

Users currently must:

1. Create `~/.claude/plugins/tailwind-lsp-adapter/.claude-plugin/plugin.json`
2. Create `~/.claude/plugins/tailwind-lsp-adapter/.lsp.json`
3. Create or update `~/.claude/plugins/.claude-plugin/marketplace.json`
4. Edit `~/.claude/settings.json`
5. Run `/plugin install` command in Claude Code
6. Set `ENABLE_LSP_TOOL=1` environment variable

---

## Research Findings

### 1. Claude Code Plugin Architecture

Claude Code uses a marketplace-based plugin system:

- **Marketplaces**: Collections of plugins from GitHub repos, URLs, or local directories
- **Installation paths**: `~/.claude/plugins/marketplaces/<marketplace-name>/plugins/<plugin-name>/`
- **Cache paths**: `~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<version>/`
- **Configuration files**:
  - `~/.claude/plugins/installed_plugins.json` - Tracks installed plugins
  - `~/.claude/plugins/known_marketplaces.json` - Registered marketplaces
  - `~/.claude/settings.json` - Enabled plugins

### 2. Official Plugin CLI Commands

Claude Code provides native CLI commands for plugin management:

```bash
# Marketplace management
claude plugin marketplace add <source>    # Add from URL, path, or GitHub repo
claude plugin marketplace list
claude plugin marketplace remove <name>

# Plugin management
claude plugin install <plugin>@<marketplace>
claude plugin enable <plugin>
claude plugin disable <plugin>
claude plugin uninstall <plugin>
```

### 3. Security Concerns with npm postinstall

**Critical Security Issues:**

| Risk | Description | Severity |
|------|-------------|----------|
| Supply Chain Attacks | postinstall scripts are a primary attack vector | Critical |
| Home Directory Access | Scripts can access ~/.ssh, credentials, .env files | High |
| Silent Execution | Runs without explicit user consent | High |
| 2025 Attack Patterns | "Dead man's switch" attacks can wipe home directories | Critical |

**Industry Best Practices (2025):**

- npm 10.0+ and pnpm disable postinstall by default
- OWASP recommends: `npm config set ignore-scripts true`
- Many security-conscious users run with `--ignore-scripts`

**Sources:**
- [NPM Security Best Practices - Snyk](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/)
- [OWASP NPM Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html)
- [npm ignore-scripts best practices](https://www.nodejs-security.com/blog/npm-ignore-scripts-best-practices-as-security-mitigation-for-malicious-packages)

### 4. How Other Plugins Handle Installation

**@schuettc/claude-code-setup Pattern:**
- Uses explicit CLI command: `claude-setup init`
- Interactive prompts for user consent
- Does NOT use postinstall scripts
- Source: [npm package](https://www.npmjs.com/package/@schuettc/claude-code-setup)

**Official Claude Code Plugins:**
- Distributed via GitHub-based marketplaces
- No npm postinstall automation
- Users explicitly run `/plugin install` command
- Source: [claude-plugins-official](https://github.com/anthropics/claude-plugins-official)

---

## Recommended Solution: Hybrid CLI Approach

### Option A: Single-Command Setup CLI (Recommended)

Add a setup CLI command to the package:

```json
{
  "bin": {
    "tailwind-lsp-adapter": "dist/index.js",
    "tailwind-lsp-setup": "dist/setup.js"
  }
}
```

**Usage:**
```bash
npm install -g tailwind-lsp-adapter
tailwind-lsp-setup          # Interactive setup
tailwind-lsp-setup --auto   # Non-interactive with defaults
tailwind-lsp-setup --check  # Verify installation
```

**Implementation Approach:**

```typescript
// src/setup.ts
#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const LOCAL_MARKETPLACE = path.join(PLUGINS_DIR, 'local-marketplace');

interface SetupOptions {
  auto?: boolean;
  check?: boolean;
  uninstall?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<void> {
  console.log('Tailwind LSP Adapter - Claude Code Plugin Setup\n');

  // 1. Verify Claude Code is installed
  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error('Error: Claude Code directory (~/.claude) not found.');
    console.error('Please install Claude Code first: https://code.claude.com/docs/en/setup');
    process.exit(1);
  }

  // 2. Check for existing installation
  const existingInstall = checkExistingInstall();
  if (existingInstall) {
    console.log('Existing installation detected.');
    if (!options.auto) {
      const proceed = await confirm('Overwrite existing configuration?');
      if (!proceed) {
        console.log('Setup cancelled.');
        process.exit(0);
      }
    }
  }

  // 3. Request consent (unless auto mode)
  if (!options.auto) {
    console.log('This setup will:');
    console.log('  - Create plugin configuration in ~/.claude/plugins/local-marketplace/');
    console.log('  - Register the plugin with Claude Code');
    console.log('');

    const consent = await confirm('Proceed with installation?');
    if (!consent) {
      console.log('Setup cancelled.');
      process.exit(0);
    }
  }

  // 4. Perform installation
  try {
    await installPlugin();
    console.log('\nSetup complete!');
    console.log('\nNext steps:');
    console.log('  1. Restart Claude Code');
    console.log('  2. Run: claude plugin install tailwindcss-lsp@local-marketplace');
    console.log('  3. Set environment variable: export ENABLE_LSP_TOOL=1');
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }
}

async function installPlugin(): Promise<void> {
  // Create directory structure
  const pluginDir = path.join(LOCAL_MARKETPLACE, 'plugins', 'tailwindcss-lsp');
  const claudePluginDir = path.join(LOCAL_MARKETPLACE, '.claude-plugin');

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(claudePluginDir, { recursive: true });

  // Write marketplace.json
  const marketplaceConfig = {
    "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
    "name": "local-marketplace",
    "description": "Local plugin marketplace for custom extensions",
    "owner": { "name": "Local", "email": "local@localhost" },
    "plugins": [{
      "name": "tailwindcss-lsp",
      "description": "Tailwind CSS language server for intelligent class suggestions",
      "version": "1.0.0",
      "author": { "name": "tailwind-lsp-adapter" },
      "source": "./plugins/tailwindcss-lsp",
      "category": "development",
      "strict": false,
      "lspServers": {
        "tailwindcss": {
          "command": "tailwind-lsp-adapter",
          "args": ["--stdio"],
          "extensionToLanguage": {
            ".css": "css", ".scss": "scss", ".less": "less",
            ".html": "html", ".jsx": "javascriptreact",
            ".tsx": "typescriptreact", ".vue": "vue", ".svelte": "svelte"
          }
        }
      }
    }]
  };

  fs.writeFileSync(
    path.join(claudePluginDir, 'marketplace.json'),
    JSON.stringify(marketplaceConfig, null, 2)
  );

  // Register marketplace in known_marketplaces.json
  const knownPath = path.join(PLUGINS_DIR, 'known_marketplaces.json');
  let known: Record<string, unknown> = {};

  if (fs.existsSync(knownPath)) {
    known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
  }

  known['local-marketplace'] = {
    source: { source: 'directory', path: LOCAL_MARKETPLACE },
    installLocation: LOCAL_MARKETPLACE,
    lastUpdated: new Date().toISOString()
  };

  fs.writeFileSync(knownPath, JSON.stringify(known, null, 2));
}

function checkExistingInstall(): boolean {
  const marketplaceJson = path.join(
    LOCAL_MARKETPLACE,
    '.claude-plugin',
    'marketplace.json'
  );
  return fs.existsSync(marketplaceJson);
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Parse CLI arguments
const args = process.argv.slice(2);
const options: SetupOptions = {
  auto: args.includes('--auto') || args.includes('-y'),
  check: args.includes('--check'),
  uninstall: args.includes('--uninstall')
};

setup(options);
```

### Option B: Integration with `claude plugin marketplace add`

Leverage Claude Code's native marketplace system:

```bash
# One-liner for users
claude plugin marketplace add /path/to/tailwind-lsp-adapter/plugin
claude plugin install tailwindcss-lsp@tailwind-lsp-adapter
```

**Package modification:**
- Include a `plugin/` directory with all necessary manifests
- Document the two-step process prominently

### Option C: npx One-Liner (No Global Install Required)

```bash
npx tailwind-lsp-adapter setup
```

Users can run setup without global installation. The setup script verifies the adapter is globally installed afterward.

---

## Why NOT to Use postinstall

| Approach | Pros | Cons |
|----------|------|------|
| **postinstall** | Automatic, zero user effort | Security risk, may be blocked, modifies home dir silently, breaks with --ignore-scripts |
| **CLI command** | Explicit consent, transparent, works with security restrictions | Requires user to run command |
| **Documentation only** | No code complexity | Poor UX, error-prone manual steps |

**Decision: CLI command is the safest approach that maintains good UX.**

---

## Implementation Plan

### Phase 1: Create Setup CLI

1. Add `src/setup.ts` with the setup logic
2. Add bin entry in package.json
3. Build and test locally

### Phase 2: Update Documentation

1. Update README.md with one-liner setup command
2. Add troubleshooting section
3. Document manual installation as fallback

### Phase 3: Add Verification

1. Add `--check` flag to verify installation
2. Add `--uninstall` flag for clean removal
3. Add `--verbose` for debugging

---

## Files to Create/Modify

```
tailwind-lsp-adapter/
  package.json          # Add "tailwind-lsp-setup" bin entry
  src/
    setup.ts            # New: CLI setup script
    index.ts            # Existing: LSP adapter
  plugin/
    .claude-plugin/
      plugin.json       # Already exists
    .lsp.json           # Already exists
  dist/
    setup.js            # Built setup script
    index.js            # Built adapter
```

---

## Usage After Implementation

```bash
# Install globally
npm install -g tailwind-lsp-adapter

# Run setup (interactive)
tailwind-lsp-setup

# Or run setup non-interactively
tailwind-lsp-setup --auto

# Verify installation
tailwind-lsp-setup --check

# Alternative: npx without global install
npx tailwind-lsp-adapter setup
```

---

## Security Considerations

1. **Explicit Consent**: Setup requires user action (not automatic)
2. **Transparency**: Shows exactly what files will be created/modified
3. **Confirmation Prompts**: Interactive mode asks before proceeding
4. **No Secrets**: Does not access or modify sensitive files
5. **Idempotent**: Safe to run multiple times
6. **Reversible**: Provides uninstall option

---

## Conclusion

The recommended approach is **Option A: Single-Command Setup CLI** because it:

- Follows established patterns (e.g., @schuettc/claude-code-setup)
- Respects user consent and security
- Works with `--ignore-scripts` npm configuration
- Provides clear feedback and next steps
- Is compatible with Claude Code's native plugin system

**Do NOT implement a postinstall script** due to security risks and industry best practices discouraging silent home directory modifications.

---

## References

- [Claude Code Plugin Documentation](https://code.claude.com/docs/en/setup)
- [NPM Security Best Practices - OWASP](https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html)
- [NPM Supply Chain Attack Analysis 2025](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/)
- [@schuettc/claude-code-setup npm](https://www.npmjs.com/package/@schuettc/claude-code-setup)
- [Claude Code Official Plugins](https://github.com/anthropics/claude-plugins-official)
