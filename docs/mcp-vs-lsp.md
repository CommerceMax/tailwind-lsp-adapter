# MCP vs LSP Adapter: Research Findings for Tailwind CSS Support in Claude Code

## Executive Summary

After researching MCP (Model Context Protocol) integration patterns and comparing them with the current LSP adapter approach, the **recommendation is to pivot to an MCP tools approach** for Tailwind CSS support in Claude Code. The MCP approach offers explicit tool invocation, better integration with Claude's decision-making, and aligns with the industry direction as MCP becomes the standard for AI-tool integration.

---

## 1. How MCP Tools Work with Claude Code

### Architecture Overview

MCP follows a client-server architecture where Claude Code acts as an MCP host that connects to MCP servers. Each connection is managed by an MCP client instance within Claude Code.

```
Claude Code (MCP Host)
    |
    +-- MCP Client 1 --> MCP Server A (local stdio)
    +-- MCP Client 2 --> MCP Server B (remote HTTP)
    +-- MCP Client 3 --> MCP Server C (SSE)
```

### Core MCP Primitives

MCP servers expose three main primitives:

1. **Tools**: Executable functions Claude can invoke (e.g., `tailwind/complete`, `tailwind/sortClasses`)
2. **Resources**: Data sources for context (e.g., `tailwind://config`, `tailwind://theme`)
3. **Prompts**: Reusable interaction templates (e.g., `/mcp__tailwind__diagnose`)

### Transport Options

- **stdio**: Local process communication (ideal for Tailwind LSP)
- **HTTP (Streamable)**: Remote servers with REST-like semantics
- **SSE**: Server-Sent Events for streaming (deprecated in favor of HTTP)

### Adding MCP Servers to Claude Code

```bash
# stdio transport (local server)
claude mcp add --transport stdio tailwind -- npx tailwind-mcp-server

# HTTP transport (remote server)
claude mcp add --transport http tailwind https://mcp.tailwind.example.com
```

---

## 2. Existing LSP-to-MCP Bridge Implementations

### lsp-mcp (github.com/Tritlo/lsp-mcp)

A general-purpose LSP-to-MCP bridge that exposes 9 primary tools:

| Tool | Description |
|------|-------------|
| `get_info_on_location` | Hover information at file positions |
| `get_completions` | Code completion suggestions |
| `get_code_actions` | Available refactoring/fix operations |
| `get_diagnostics` | Error/warning messages |
| `open_document` / `close_document` | File lifecycle management |
| `start_lsp` / `restart_lsp_server` | LSP initialization control |
| `set_log_level` | Runtime logging configuration |

**Key Design Decisions**:
- Requires explicit `start_lsp` call before operations
- Files must be opened via `open_document` before diagnostics
- Provides both tool-based and resource-based access patterns

**Resources Exposed**:
- `lsp-diagnostics://` - Real-time error/warning updates
- `lsp-hover://` - Type information queries
- `lsp-completions://` - Completion suggestions

### cclsp (github.com/ktnyt/cclsp)

Specifically designed for Claude Code with intelligent position handling:

| Tool | Description |
|------|-------------|
| `find_definition` | Locate symbol definitions |
| `find_references` | Workspace-wide reference search |
| `rename_symbol` | Multi-file symbol renaming |
| `rename_symbol_strict` | Position-specific renaming |
| `get_diagnostics` | Linting and type errors |
| `restart_server` | LSP recovery mechanism |

**Key Innovation**: "Intelligent trying" - compensates for LLM position counting inconsistencies by attempting multiple interpretations of line/column coordinates.

---

## 3. Tailwind Features as MCP Tools

### Proposed Tool Set

Based on the Tailwind CSS Language Server capabilities, here are the recommended MCP tools:

#### `tailwind/complete`
Autocomplete suggestions for Tailwind classes.

```typescript
interface CompleteParams {
  file: string;           // File path or URI
  content: string;        // File content (or use open document)
  line: number;           // Cursor line (0-indexed)
  character: number;      // Cursor column (0-indexed)
  triggerKind?: 'invoked' | 'character' | 'incomplete';
  triggerCharacter?: string;
}

interface CompleteResult {
  items: Array<{
    label: string;        // e.g., "bg-blue-500"
    detail?: string;      // e.g., "background-color: #3b82f6"
    documentation?: string;
    kind: 'class' | 'variant' | 'directive';
  }>;
  isIncomplete: boolean;
}
```

**Use Cases**:
- Claude asks "what Tailwind classes can I use for background colors?"
- Claude wants to complete a partially typed class name
- Claude needs to find responsive variants

#### `tailwind/sortClasses`
Reorder Tailwind classes according to recommended order.

```typescript
interface SortClassesParams {
  file: string;
  classes: string;        // Space-separated class string
  // OR
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface SortClassesResult {
  sorted: string;         // Reordered class string
  changes: number;        // Number of classes moved
}
```

**Use Cases**:
- Claude wants to format a messy class string
- Ensuring consistent class ordering in generated code

#### `tailwind/codeAction`
Get available quick fixes and refactoring options.

```typescript
interface CodeActionParams {
  file: string;
  content: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  diagnostics?: Diagnostic[];  // Optional: filter by diagnostics
}

interface CodeActionResult {
  actions: Array<{
    title: string;
    kind: string;         // e.g., "quickfix", "refactor"
    edit?: WorkspaceEdit;
    isPreferred?: boolean;
  }>;
}
```

**Use Cases**:
- Fixing invalid Tailwind directives
- Extracting repeated classes into @apply
- Converting between equivalent utilities

#### `tailwind/diagnose`
Get diagnostics (errors, warnings) for Tailwind usage.

```typescript
interface DiagnoseParams {
  file: string;
  content: string;
}

interface DiagnoseResult {
  diagnostics: Array<{
    range: Range;
    message: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    code?: string;        // e.g., "cssConflict", "invalidApply"
    source: 'tailwindcss';
  }>;
}
```

**Use Cases**:
- Validating Tailwind classes before committing
- Finding CSS conflicts in class strings
- Detecting invalid @apply usage

#### Additional Recommended Tools

| Tool | Purpose |
|------|---------|
| `tailwind/hover` | Get CSS preview for a class at position |
| `tailwind/resolveConfig` | Get resolved Tailwind config values |
| `tailwind/colorInfo` | Get color preview and values |
| `tailwind/extractClasses` | Extract class strings from content |

---

## 4. Comparison: LSP Adapter vs MCP Tools

### Current LSP Adapter Approach

```
Claude Code LSP Client
    |
    v
tailwind-lsp-adapter (proxy)
    |
    +-- Intercepts unsupported methods
    +-- Patches initialize capabilities
    +-- Forwards messages bidirectionally
    |
    v
@tailwindcss/language-server
```

**Advantages**:
- Transparent to Claude Code (works like any LSP)
- No changes needed to Claude Code's LSP client
- Full LSP protocol support (hover, completion, diagnostics, etc.)
- Established protocol with mature tooling

**Disadvantages**:
- Claude Code controls when/what to request
- No explicit tool invocation - Claude cannot directly ask for features
- Requires adapter layer to handle protocol mismatches
- Claude has no visibility into available Tailwind-specific capabilities
- Stream-based, stateful protocol is complex to manage

### MCP Tools Approach

```
Claude Code (MCP Host)
    |
    v
tailwind-mcp-server
    |
    +-- Exposes explicit tools (complete, diagnose, etc.)
    +-- Manages LSP server lifecycle internally
    |
    v
@tailwindcss/language-server (internal)
```

**Advantages**:
- Explicit tool invocation - Claude chooses when to use Tailwind features
- Tools appear in Claude's capability list (discoverable)
- Can provide Tailwind-specific prompts and resources
- Simpler integration - JSON-RPC tools vs stateful LSP stream
- Better error handling and result formatting
- Aligns with MCP ecosystem growth (Gartner: 75% API gateway support by 2026)
- Linux Foundation backing ensures long-term viability

**Disadvantages**:
- Requires implementing MCP server wrapper
- Less automatic - Claude must explicitly invoke tools
- May not cover all LSP features without additional tools
- Newer ecosystem than LSP

---

## 5. Recommendation: Pivot to MCP Tools

### Rationale

1. **Explicit Invocation**: MCP tools let Claude explicitly request Tailwind features rather than hoping LSP events trigger at the right time. Claude can ask "check my Tailwind classes for errors" and directly invoke `tailwind/diagnose`.

2. **Discoverability**: MCP tools appear in Claude's tool list. Claude knows exactly what Tailwind capabilities are available and can reason about when to use them.

3. **Industry Direction**: MCP is rapidly becoming the standard for AI-tool integration:
   - OpenAI adopted MCP in March 2025
   - Apple integrated MCP in Xcode 26.3
   - Linux Foundation (Agentic AI Foundation) now stewards MCP
   - Gartner predicts 75% API gateway support by 2026

4. **Simpler Protocol**: MCP uses JSON-RPC tools with clear request/response semantics, avoiding the complexity of LSP's stateful streams.

5. **Better Claude Integration**: Claude Code has first-class MCP support with features like:
   - Dynamic tool updates via `list_changed` notifications
   - OAuth authentication for remote servers
   - Tool search for large tool sets
   - Resource references via `@` mentions

6. **Complementary Approaches**: The LSP server can still power the MCP tools internally. The MCP server acts as a bridge that exposes LSP features as explicit tools.

### Proposed Architecture

```
Claude Code (MCP Host)
    |
    v
tailwind-mcp-server (new)
    |
    +-- Tools: complete, sortClasses, codeAction, diagnose, hover
    +-- Resources: tailwind://config, tailwind://theme
    +-- Prompts: /mcp__tailwind__setup, /mcp__tailwind__validate
    |
    +-- Internal: LSP client to @tailwindcss/language-server
    |
    v
@tailwindcss/language-server (stdio)
```

### Implementation Priority

1. **Phase 1**: Core tools
   - `tailwind/complete` - Autocomplete
   - `tailwind/diagnose` - Diagnostics
   - `tailwind/hover` - CSS preview

2. **Phase 2**: Code modification
   - `tailwind/sortClasses` - Class sorting
   - `tailwind/codeAction` - Quick fixes

3. **Phase 3**: Resources and prompts
   - `tailwind://config` - Configuration resource
   - `/mcp__tailwind__validate` - Validation prompt

### Migration Path

The existing LSP adapter can remain functional during transition. Users can choose between:
- LSP adapter (current): `claude mcp add tailwind-lsp -- tailwind-lsp-adapter`
- MCP server (new): `claude mcp add tailwind -- tailwind-mcp-server`

---

## 6. Technical Implementation Notes

### MCP Server Setup

Use the MCP TypeScript SDK:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "tailwind-mcp-server",
  version: "1.0.0",
});

server.tool("tailwind/complete", {
  description: "Get Tailwind CSS class completions at cursor position",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "File path" },
      content: { type: "string", description: "File content" },
      line: { type: "number", description: "Cursor line (0-indexed)" },
      character: { type: "number", description: "Cursor column" },
    },
    required: ["file", "content", "line", "character"],
  },
}, async (params) => {
  // Invoke internal LSP client
  const completions = await lspClient.completion(params);
  return { content: [{ type: "text", text: JSON.stringify(completions) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### LSP Client Integration

The MCP server maintains an internal LSP client:

```typescript
class TailwindLspClient {
  private serverProcess: ChildProcess;
  private messageBuffer: MessageBuffer;

  async initialize(rootUri: string): Promise<void> {
    this.serverProcess = spawn("tailwindcss-language-server", ["--stdio"]);
    // Send initialize request, handle capabilities
  }

  async completion(params: CompletionParams): Promise<CompletionItem[]> {
    // Open document if needed
    // Send textDocument/completion request
    // Return formatted results
  }

  async diagnostics(uri: string, content: string): Promise<Diagnostic[]> {
    // Open/update document
    // Request diagnostics
    // Return formatted results
  }
}
```

---

## 7. Conclusion

The MCP tools approach offers significant advantages over the LSP adapter for Tailwind CSS support in Claude Code:

| Aspect | LSP Adapter | MCP Tools |
|--------|-------------|-----------|
| Invocation | Implicit (editor-driven) | Explicit (Claude-driven) |
| Discoverability | Hidden | Visible in tool list |
| Protocol | Complex stateful stream | Simple request/response |
| Industry support | Mature but static | Growing rapidly |
| Claude integration | Generic LSP client | First-class MCP support |

**Recommendation**: Build a tailwind-mcp-server that wraps the existing Tailwind CSS Language Server and exposes its features as explicit MCP tools. This provides Claude with direct, discoverable access to Tailwind capabilities while leveraging the proven LSP implementation.

---

## Sources

- [MCP Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)
- [lsp-mcp GitHub Repository](https://github.com/Tritlo/lsp-mcp)
- [cclsp GitHub Repository](https://github.com/ktnyt/cclsp)
- [@tailwindcss/language-server npm Package](https://www.npmjs.com/package/@tailwindcss/language-server)
- [Tailwind CSS LSP in Zed](https://zed.dev/docs/languages/tailwindcss)
- [Debugging Tailwind's LSP](https://www.sinclair.software/articles/debugging-tailwinds-lsp/)
- [Anthropic MCP Announcement](https://www.anthropic.com/news/model-context-protocol)
