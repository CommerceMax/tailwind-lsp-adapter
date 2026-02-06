# Claude Code LSP Support Research

**Date:** February 6, 2026
**Purpose:** Research Claude Code's LSP capabilities and determine implementation strategies for Tailwind CSS LSP adapter

---

## Executive Summary

Claude Code officially added LSP support in version 2.0.74 (December 2025), but the implementation focuses on **navigation and diagnostics** rather than **editing operations** like completion, code actions, and formatting. The adapter needs alternative strategies to provide Tailwind CSS IntelliSense features.

---

## 1. Claude Code Built-in LSP Support

### 1.1 Officially Supported LSP Operations

Claude Code's built-in LSP tool supports **9 operations** mapped to standard LSP methods:

| Operation | LSP Method | Description |
|-----------|-----------|-------------|
| `goToDefinition` | `textDocument/definition` | Find where a symbol is defined |
| `findReferences` | `textDocument/references` | Find all references to a symbol |
| `hover` | `textDocument/hover` | Get documentation and type info |
| `documentSymbol` | `textDocument/documentSymbol` | Get all symbols in a document |
| `workspaceSymbol` | `workspace/symbol` | Search symbols across workspace |
| `goToImplementation` | `textDocument/implementation` | Find implementations of interfaces |
| `prepareCallHierarchy` | `textDocument/prepareCallHierarchy` | Get call hierarchy items |
| `incomingCalls` | `callHierarchy/incomingCalls` | Find callers of a function |
| `outgoingCalls` | `callHierarchy/outgoingCalls` | Find callees from a function |

**Additional feature:**
- **Automatic Diagnostics**: After every file edit, the language server analyzes changes and reports errors/warnings automatically via `textDocument/publishDiagnostics`.

### 1.2 NOT Supported by Claude Code's Built-in LSP Tool

| LSP Method | Feature | Status |
|-----------|---------|--------|
| `textDocument/completion` | Autocomplete suggestions | **Not supported** |
| `textDocument/codeAction` | Quick fixes, refactoring | **Not supported** |
| `textDocument/formatting` | Document formatting | **Not supported** |
| `textDocument/rangeFormatting` | Selection formatting | **Not supported** |
| `textDocument/rename` | Symbol renaming | **Not supported** |
| `textDocument/signatureHelp` | Function signature help | **Not supported** |
| `textDocument/documentHighlight` | Symbol highlighting | **Not supported** |

### 1.3 Current Issues with Claude Code LSP

Based on GitHub issues research:

1. **Windows Path Issues** ([Issue #17094](https://github.com/anthropics/claude-code/issues/17094)): Windows file paths not converted to proper `file://` URIs
2. **Empty Results Bug** ([Issue #17312](https://github.com/anthropics/claude-code/issues/17312)): Document-level operations return empty despite server responding correctly
3. **textDocument/didOpen Not Sent** ([Issue #16804](https://github.com/anthropics/claude-code/issues/16804)): Files not registered with LSP server
4. **Missing Request Handlers** ([Issue #16360](https://github.com/anthropics/claude-code/issues/16360)): LSP client missing handlers for `workspace/configuration`, `client/registerCapability`
5. **Plugin Loading Issues** ([Issue #14803](https://github.com/anthropics/claude-code/issues/14803)): `LspServerManager.initialize()` appears non-functional

---

## 2. Tailwind CSS Language Server Capabilities

The `@tailwindcss/language-server` (part of tailwindcss-intellisense) provides:

### 2.1 Full LSP Feature Set

| Method | Feature | Description |
|--------|---------|-------------|
| `textDocument/completion` | Autocomplete | Class names, CSS functions, directives |
| `textDocument/hover` | Hover previews | Complete CSS for Tailwind classes |
| `textDocument/codeAction` | Code actions | Linting quick fixes |
| `textDocument/documentColor` | Color preview | Color swatches for color classes |
| `textDocument/publishDiagnostics` | Diagnostics | Linting errors and warnings |

### 2.2 Tailwind-Specific Features

- **Class name completion** with intelligent suggestions
- **Emmet-style syntax** support (e.g., `div.bg-red-500.uppercase`)
- **Custom attributes** support: `class`, `className`, `ngClass`, `class:list`
- **Linting rules** for conflicts, unknown variants, unknown screens
- **CSS preview on hover** with px/rem equivalents
- **Class sorting** commands

---

## 3. Alternative Approaches and Workarounds

### 3.1 Third-Party MCP Servers with Full LSP Support

#### lsp-mcp (Tritlo/lsp-mcp)

**Repository:** https://github.com/Tritlo/lsp-mcp

An MCP server that provides **full LSP method access** including completion and code actions:

**Tools provided:**
- `get_completions` - `textDocument/completion` support
- `get_code_actions` - `textDocument/codeAction` support
- `get_info_on_location` - `textDocument/hover` support
- `get_diagnostics` - Diagnostic messages
- `open_document` / `close_document` - File management
- `start_lsp` / `restart_lsp_server` - Server lifecycle

**Resource endpoints:**
- `lsp-completions://` - Completion queries
- `lsp-hover://` - Hover information
- `lsp-diagnostics://` - Diagnostic subscriptions

**Configuration:**
```bash
npx tritlo/lsp-mcp tailwindcss /path/to/tailwindcss-language-server
```

#### cclsp (ktnyt/cclsp)

**Repository:** https://github.com/ktnyt/cclsp

An MCP server focusing on robust symbol resolution:

**Tools provided:**
- `find_definition` - Go to definition
- `find_references` - Find all usages
- `rename_symbol` - Cross-file renaming
- `rename_symbol_strict` - Precise position-based renaming
- `get_diagnostics` - Diagnostic retrieval
- `restart_server` - Server management

**Key feature:** Handles LLM imprecision with line/column numbers by trying multiple position combinations.

#### mcp-language-server (isaacphi/mcp-language-server)

**Repository:** https://github.com/isaacphi/mcp-language-server

**Tools provided:**
- `definition` - Symbol definitions
- `references` - Symbol references
- `diagnostics` - File diagnostics
- `hover` - Hover documentation
- `rename_symbol` - Renaming
- `edit_file` - Text edits

### 3.2 Community Patches

The **Piebald-AI/claude-code-lsps** project provides a workaround:

```bash
npx tweakcc --apply
```

This patches Claude Code to properly load LSP servers from plugins, addressing the `LspServerManager.initialize()` issue.

---

## 4. Adapter Implementation Strategy

### 4.1 Option A: Direct MCP Tool Implementation

Implement our own MCP tools that communicate directly with `tailwindcss-language-server`:

```typescript
// Example tool definitions for adapter
{
  name: "tailwind_complete",
  description: "Get Tailwind CSS class completions",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      line: { type: "number" },
      character: { type: "number" }
    }
  }
}
```

**Pros:**
- Full control over LSP interaction
- Custom response formatting for Claude
- Can add Tailwind-specific intelligence

**Cons:**
- Requires implementing LSP client logic
- Must manage server lifecycle

### 4.2 Option B: Wrap lsp-mcp

Use `lsp-mcp` as a dependency and expose Tailwind-specific tools:

```typescript
import { LspMcpServer } from 'lsp-mcp';

// Configure for Tailwind CSS
const tailwindLsp = new LspMcpServer({
  language: 'tailwindcss',
  serverPath: '@tailwindcss/language-server',
  serverArgs: ['--stdio']
});
```

**Pros:**
- Proven LSP implementation
- Handles completion, code actions natively
- Less code to maintain

**Cons:**
- Additional dependency
- May need modifications for Tailwind-specific behavior

### 4.3 Option C: Hybrid Approach (Recommended)

1. **Use Claude Code's built-in LSP** for supported operations:
   - Diagnostics (automatic)
   - Hover (via `hover` operation)

2. **Implement custom MCP tools** for unsupported operations:
   - `tailwind/complete` - Completion suggestions
   - `tailwind/codeAction` - Quick fixes
   - `tailwind/formatClasses` - Class sorting

3. **Provide helper prompts** that guide Claude to use appropriate tools

---

## 5. Implementation Requirements for Missing Features

### 5.1 textDocument/completion (Autocomplete)

**What the adapter needs to provide:**

```typescript
interface CompletionRequest {
  filePath: string;
  position: { line: number; character: number };
  triggerKind?: CompletionTriggerKind;
  triggerCharacter?: string;
}

interface CompletionResponse {
  items: CompletionItem[];
  isIncomplete: boolean;
}
```

**Trigger characters for Tailwind:** `"`, `'`, `` ` ``, ` `, `.`, `(`, `[`, `!`, `/`, `:`

### 5.2 textDocument/codeAction (Quick Fixes)

**Use cases for Tailwind:**
- Replace deprecated classes
- Fix class ordering issues
- Remove duplicate utilities
- Suggest class merging

```typescript
interface CodeActionRequest {
  filePath: string;
  range: Range;
  diagnostics?: Diagnostic[];
}
```

### 5.3 textDocument/formatting (Class Sorting)

Tailwind provides a Prettier plugin for class sorting. The adapter can:
- Invoke the Prettier plugin directly
- Or implement sorting logic based on Tailwind's official order

### 5.4 textDocument/rename (Not Typically Needed)

Tailwind classes are string literals, not symbols. Renaming would be:
- Search and replace across files
- Could use Claude's built-in Edit tool

---

## 6. Recommendations

### 6.1 Immediate Actions

1. **Implement custom MCP completion tool** using direct LSP client
2. **Leverage Claude's built-in diagnostics** for linting errors
3. **Use hover for CSS previews** (already supported)

### 6.2 Tool Priority

| Tool | Priority | Implementation Complexity |
|------|----------|--------------------------|
| `tailwind/complete` | **High** | Medium - Core value proposition |
| `tailwind/hover` | **High** | Low - Built-in support exists |
| `tailwind/diagnostics` | **High** | Low - Built-in support exists |
| `tailwind/codeAction` | **Medium** | Medium - For quick fixes |
| `tailwind/sortClasses` | **Low** | Low - Prettier integration |
| `tailwind/formatDocument` | **Low** | Low - Prettier integration |

### 6.3 Architecture Recommendation

```
┌─────────────────────────────────────────────────────────┐
│                     Claude Code                          │
│  ┌────────────────┐    ┌────────────────────────────┐  │
│  │ Built-in LSP   │    │    MCP Server (Adapter)    │  │
│  │ - hover        │    │ ┌────────────────────────┐ │  │
│  │ - diagnostics  │    │ │ tailwind/complete      │ │  │
│  │ - goToDefn     │    │ │ tailwind/codeAction    │ │  │
│  └───────┬────────┘    │ │ tailwind/sortClasses   │ │  │
│          │             │ └───────────┬────────────┘ │  │
│          │             │             │              │  │
└──────────┼─────────────┼─────────────┼──────────────┘  │
           │             │             │                  │
           ▼             │             ▼                  │
    ┌──────────────┐     │    ┌──────────────────────┐   │
    │ LSP Plugin   │     │    │ Direct LSP Client    │   │
    │ (if using)   │     │    │ (JSON-RPC over stdio)│   │
    └──────────────┘     │    └──────────┬───────────┘   │
                         │               │               │
                         │               ▼               │
                         │    ┌──────────────────────┐   │
                         │    │ tailwindcss-language │   │
                         │    │       -server        │   │
                         │    └──────────────────────┘   │
                         └───────────────────────────────┘
```

---

## 7. Source References

### Official Documentation
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code Discover Plugins](https://code.claude.com/docs/en/discover-plugins)
- [Tailwind CSS Editor Setup](https://tailwindcss.com/docs/editor-setup)

### GitHub Repositories
- [tailwindlabs/tailwindcss-intellisense](https://github.com/tailwindlabs/tailwindcss-intellisense)
- [Tritlo/lsp-mcp](https://github.com/Tritlo/lsp-mcp)
- [ktnyt/cclsp](https://github.com/ktnyt/cclsp)
- [isaacphi/mcp-language-server](https://github.com/isaacphi/mcp-language-server)
- [Piebald-AI/claude-code-lsps](https://github.com/Piebald-AI/claude-code-lsps)

### Issue Trackers
- [Claude Code LSP Issues](https://github.com/anthropics/claude-code/issues?q=LSP)
- [tailwindcss-intellisense LSP Issues](https://github.com/tailwindlabs/tailwindcss-intellisense/issues)

### Community Articles
- [How Claude Code's New LSP Support Changes the Way You Debug](https://medium.com/algomart/how-claude-codes-new-lsp-support-changes-the-way-you-debug-navigate-and-understand-code-d9649eb6dd33)
- [Claude Code LSP Complete Setup Guide](https://www.aifreeapi.com/en/posts/claude-code-lsp)
- [Hacker News Discussion: Claude Code gets native LSP support](https://news.ycombinator.com/item?id=46355165)

---

## 8. Conclusion

Claude Code's LSP support is focused on **code navigation** (go-to-definition, find-references) and **diagnostics** rather than **editing assistance** (completion, code actions, formatting). For a Tailwind CSS adapter to provide meaningful IntelliSense:

1. **Do not rely on Claude Code's built-in LSP** for completion/code actions
2. **Implement direct LSP client communication** with `tailwindcss-language-server`
3. **Expose tools via MCP** that Claude can call for Tailwind-specific features
4. **Leverage built-in diagnostics** where possible (via LSP plugin system)

The recommended approach is a **hybrid architecture** that uses Claude Code's native capabilities where available while providing custom MCP tools for the critical missing features like autocomplete.
