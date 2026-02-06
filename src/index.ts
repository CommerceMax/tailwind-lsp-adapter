#!/usr/bin/env node

/**
 * Tailwind CSS LSP Adapter for Claude Code
 *
 * Transparent proxy between Claude Code's LSP client and @tailwindcss/language-server.
 * Intercepts and handles LSP methods that Claude Code doesn't support:
 *   - client/registerCapability  (dynamic capability registration)
 *   - workspace/configuration    (workspace settings requests)
 *   - window/workDoneProgress/create (progress reporting)
 *
 * Architecture:
 *   Claude Code  <-->  tailwind-lsp-adapter  <-->  @tailwindcss/language-server
 *                            |
 *                     Intercepts and handles
 *                     unsupported LSP methods
 */

import { spawn, ChildProcess, execFileSync } from "child_process";
import { resolve } from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Security: Allowlist for valid LSP server commands
const ALLOWED_SERVER_NAMES = [
  'tailwindcss-language-server',
  '@tailwindcss/language-server',
];

/**
 * Validate that the server command is an allowed Tailwind LSP server.
 * Prevents command injection via TAILWIND_LSP_COMMAND env var.
 */
function validateServerCommand(cmd: string): string {
  const basename = cmd.split('/').pop() || cmd;
  if (!ALLOWED_SERVER_NAMES.some(allowed => basename.includes(allowed))) {
    console.error(`Security: Invalid LSP command "${cmd}". Must be tailwindcss-language-server.`);
    process.exit(1);
  }
  return cmd;
}

const SERVER_COMMAND = validateServerCommand(
  process.env.TAILWIND_LSP_COMMAND || "tailwindcss-language-server"
);
const SERVER_ARGS = (process.env.TAILWIND_LSP_ARGS || "--stdio").split(" ");
const DEBUG = process.env.LSP_ADAPTER_DEBUG === "1";

// Security: Use unique filename with random suffix to prevent predictable paths
const LOG_FILE = resolve(
  os.tmpdir(),
  `tailwind-lsp-adapter-${process.pid}-${crypto.randomBytes(4).toString('hex')}.log`
);

// ---------------------------------------------------------------------------
// Security: Path Validation
// ---------------------------------------------------------------------------

/** Forbidden paths that should never be used as workspace roots */
const FORBIDDEN_PATHS = ['/etc', '/usr', '/bin', '/sbin', '/var', '/root', '/sys', '/proc', '/dev'];

/**
 * Validate that a workspace path is safe to use.
 * Prevents path traversal attacks targeting sensitive system directories.
 */
function validateWorkspacePath(rootPath: string): string | null {
  const resolved = resolve(rootPath);
  for (const forbidden of FORBIDDEN_PATHS) {
    if (resolved === forbidden || resolved.startsWith(forbidden + '/')) {
      log("SECURITY", `Rejected forbidden workspace: ${resolved}`);
      return null;
    }
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      log("SECURITY", `Workspace path is not a directory: ${resolved}`);
      return null;
    }
  } catch {
    log("SECURITY", `Cannot access workspace path: ${resolved}`);
    return null;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tailwind v4 Auto-Detection
// ---------------------------------------------------------------------------

/** Cached workspace root from initialize request */
let workspaceRoot: string | null = null;

/** Cached CSS entrypoint for v4 projects */
let detectedCssEntrypoint: string | null | undefined = undefined; // undefined = not searched yet

/**
 * Auto-detect Tailwind v4 CSS entrypoint by searching for files with
 * @import "tailwindcss" or @import 'tailwindcss'
 */
function detectTailwindV4Entrypoint(): string | null {
  // Return cached result if already searched
  if (detectedCssEntrypoint !== undefined) {
    return detectedCssEntrypoint;
  }

  // Check env var first
  if (process.env.TAILWIND_CSS_ENTRYPOINT) {
    detectedCssEntrypoint = process.env.TAILWIND_CSS_ENTRYPOINT;
    log("V4-DETECT", `Using env var: ${detectedCssEntrypoint}`);
    return detectedCssEntrypoint;
  }

  // Need workspace root to search
  if (!workspaceRoot) {
    log("V4-DETECT", "No workspace root yet, skipping detection");
    detectedCssEntrypoint = null;
    return null;
  }

  try {
    // Use grep to find CSS files with Tailwind v4 import
    // Search for: @import "tailwindcss" or @import 'tailwindcss'
    // Security: Use execFileSync with array arguments to prevent command injection
    const grepResult = execFileSync('grep', [
      '-r', '-l', '--include=*.css',
      '-e', '@import "tailwindcss"',
      '-e', "@import 'tailwindcss'",
      workspaceRoot
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });

    // Limit results to first 5 files
    const result = grepResult.trim().split('\n').slice(0, 5).join('\n');

    if (result) {
      const files = result.split("\n").filter(f => f.length > 0);

      // Prefer src/index.css, src/app.css, src/styles.css, or first found
      const priorities = ["index.css", "app.css", "styles.css", "global.css", "main.css"];
      let bestMatch = files[0];

      for (const priority of priorities) {
        const match = files.find(f => f.endsWith(`/src/${priority}`) || f.endsWith(`/${priority}`));
        if (match) {
          bestMatch = match;
          break;
        }
      }

      // Convert to relative path from workspace root
      if (bestMatch.startsWith(workspaceRoot)) {
        detectedCssEntrypoint = bestMatch.substring(workspaceRoot.length + 1);
      } else {
        detectedCssEntrypoint = bestMatch;
      }

      log("V4-DETECT", `Found v4 entrypoint: ${detectedCssEntrypoint}`);
      return detectedCssEntrypoint;
    }
  } catch (err) {
    log("V4-DETECT", `Search failed: ${err}`);
  }

  // No v4 entrypoint found - might be v3 project with config file
  detectedCssEntrypoint = null;
  log("V4-DETECT", "No v4 entrypoint found (might be v3 project)");
  return null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logStream: fs.WriteStream | null = null;

function log(direction: string, message: string): void {
  if (!DEBUG) return;
  if (!logStream) {
    // Security: Create log file with restrictive permissions (owner read/write only)
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a", mode: 0o600 });
  }
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ${direction} ${message}\n`);
}

// ---------------------------------------------------------------------------
// JSON-RPC message parsing (LSP uses Content-Length headers over stdio)
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class MessageBuffer {
  private buffer = Buffer.alloc(0);
  private contentLength: number | null = null;

  /**
   * Feed raw data into the buffer and extract complete JSON-RPC messages.
   */
  feed(data: Buffer): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages: JsonRpcMessage[] = [];

    while (true) {
      // Parse headers if we haven't found Content-Length yet
      if (this.contentLength === null) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const headerStr = this.buffer.subarray(0, headerEnd).toString("utf-8");
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Malformed header — skip past it
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      // Check if we have the full message body
      if (this.buffer.length < this.contentLength) break;

      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = null;

      try {
        messages.push(JSON.parse(body));
      } catch {
        log("ERROR", `Failed to parse JSON: ${body.substring(0, 200)}`);
      }
    }

    return messages;
  }
}

/**
 * Encode a JSON-RPC message with Content-Length header.
 */
function encodeMessage(msg: JsonRpcMessage): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
  return Buffer.from(header + body, "utf-8");
}

// ---------------------------------------------------------------------------
// Intercepted method handlers
// ---------------------------------------------------------------------------

/** Registered capabilities (tracked for potential future use) */
const registeredCapabilities: Map<string, any> = new Map();

/** Track pending requests to correlate responses with their original requests */
interface PendingRequest {
  method: string;
  timestamp: number;
  context?: string;
}
const pendingRequests: Map<number | string, PendingRequest> = new Map();

/**
 * Handle `client/registerCapability` — the server wants to dynamically
 * register capabilities. We accept them silently and respond with success.
 */
function handleRegisterCapability(msg: JsonRpcMessage): JsonRpcMessage {
  const registrations = msg.params?.registrations || [];
  for (const reg of registrations) {
    registeredCapabilities.set(reg.id, {
      method: reg.method,
      registerOptions: reg.registerOptions,
    });
    log(
      "INTERCEPT",
      `Registered capability: ${reg.method} (id: ${reg.id})`
    );
  }
  return { jsonrpc: "2.0", id: msg.id!, result: null };
}

/**
 * Handle `client/unregisterCapability` — remove previously registered
 * capabilities.
 */
function handleUnregisterCapability(msg: JsonRpcMessage): JsonRpcMessage {
  const unregistrations = msg.params?.unregisterations || msg.params?.unregistrations || [];
  for (const unreg of unregistrations) {
    registeredCapabilities.delete(unreg.id);
    log("INTERCEPT", `Unregistered capability: ${unreg.method} (id: ${unreg.id})`);
  }
  return { jsonrpc: "2.0", id: msg.id!, result: null };
}

/**
 * Handle `workspace/configuration` — the server is asking for workspace
 * settings. Return empty configs (Tailwind LSP works fine with defaults).
 */
function handleWorkspaceConfiguration(msg: JsonRpcMessage): JsonRpcMessage {
  const items = msg.params?.items || [];
  const results = items.map((item: any) => {
    log(
      "INTERCEPT",
      `workspace/configuration request for section: ${item.section || "(none)"}`
    );

    // Return Tailwind-specific defaults when asked
    if (item.section === "tailwindCSS") {
      return {
        emmetCompletions: false,
        includeLanguages: {},
        classAttributes: ["class", "className", "ngClass"],
        lint: {
          cssConflict: "warning",
          invalidApply: "error",
          invalidScreen: "error",
          invalidVariant: "error",
          invalidConfigPath: "error",
          invalidTailwindDirective: "error",
          recommendedVariantOrder: "warning",
        },
        // Support Tailwind v4 CSS-first configuration
        // Auto-detects CSS files with @import "tailwindcss", or use TAILWIND_CSS_ENTRYPOINT env var
        experimental: {
          configFile: detectTailwindV4Entrypoint(),
        },
        showPixelEquivalents: true,
        rootFontSize: 16,
      };
    }

    // For editor settings, return sensible defaults
    if (item.section === "editor") {
      return { tabSize: 2 };
    }

    // Default: return empty object
    return {};
  });

  return { jsonrpc: "2.0", id: msg.id!, result: results };
}

/**
 * Handle `window/workDoneProgress/create` — the server wants to create a
 * progress token. Accept it silently.
 */
function handleWorkDoneProgressCreate(msg: JsonRpcMessage): JsonRpcMessage {
  log(
    "INTERCEPT",
    `Progress token created: ${msg.params?.token}`
  );
  return { jsonrpc: "2.0", id: msg.id!, result: null };
}

/**
 * Handle `window/showMessage` — log but don't forward to client
 * (Claude Code may not handle these well).
 */
function handleWindowShowMessage(msg: JsonRpcMessage): null {
  log(
    "INTERCEPT",
    `window/showMessage [${msg.params?.type}]: ${msg.params?.message}`
  );
  return null; // Don't forward, just absorb
}

// ---------------------------------------------------------------------------
// Formatting and Rename request logging
// ---------------------------------------------------------------------------

/**
 * Log formatting request details for debugging.
 * These requests are forwarded to the server without modification.
 */
function logFormattingRequest(msg: JsonRpcMessage): void {
  const uri = msg.params?.textDocument?.uri || "(unknown)";
  const options = msg.params?.options || {};
  log(
    "FORMAT",
    `textDocument/formatting for ${uri} (tabSize: ${options.tabSize}, insertSpaces: ${options.insertSpaces})`
  );
}

/**
 * Log range formatting request details for debugging.
 * These requests are forwarded to the server without modification.
 */
function logRangeFormattingRequest(msg: JsonRpcMessage): void {
  const uri = msg.params?.textDocument?.uri || "(unknown)";
  const range = msg.params?.range;
  if (range) {
    log(
      "FORMAT",
      `textDocument/rangeFormatting for ${uri} (${range.start.line}:${range.start.character} to ${range.end.line}:${range.end.character})`
    );
  } else {
    log("FORMAT", `textDocument/rangeFormatting for ${uri} (no range)`);
  }
}

/**
 * Log prepare rename request details for debugging.
 * These requests are forwarded to the server without modification.
 */
function logPrepareRenameRequest(msg: JsonRpcMessage): void {
  const uri = msg.params?.textDocument?.uri || "(unknown)";
  const position = msg.params?.position;
  if (position) {
    log(
      "RENAME",
      `textDocument/prepareRename at ${uri}:${position.line}:${position.character}`
    );
  } else {
    log("RENAME", `textDocument/prepareRename for ${uri} (no position)`);
  }
}

/**
 * Log rename request details for debugging.
 * These requests are forwarded to the server without modification.
 */
function logRenameRequest(msg: JsonRpcMessage): void {
  const uri = msg.params?.textDocument?.uri || "(unknown)";
  const position = msg.params?.position;
  const newName = msg.params?.newName || "(unknown)";
  if (position) {
    log(
      "RENAME",
      `textDocument/rename at ${uri}:${position.line}:${position.character} -> "${newName}"`
    );
  } else {
    log("RENAME", `textDocument/rename for ${uri} -> "${newName}"`);
  }
}

// ---------------------------------------------------------------------------
// Completion request logging
// ---------------------------------------------------------------------------

/**
 * Log textDocument/completion request details for debugging.
 * Tracks the request for correlating with the response.
 */
function logCompletionRequest(msg: JsonRpcMessage): void {
  const uri = msg.params?.textDocument?.uri || "(unknown)";
  const position = msg.params?.position;
  const context = msg.params?.context;

  let logMsg = `textDocument/completion id=${msg.id} uri=${uri}`;
  if (position) {
    logMsg += ` line=${position.line} char=${position.character}`;
  }
  if (context?.triggerKind) {
    const triggerKinds = ["", "Invoked", "TriggerCharacter", "TriggerForIncompleteCompletions"];
    logMsg += ` trigger=${triggerKinds[context.triggerKind] || context.triggerKind}`;
    if (context.triggerCharacter) {
      logMsg += ` char="${context.triggerCharacter}"`;
    }
  }

  log("COMPLETION", logMsg);

  // Track the request for response correlation
  if (msg.id !== undefined) {
    pendingRequests.set(msg.id, {
      method: "textDocument/completion",
      timestamp: Date.now(),
      context: uri,
    });
  }
}

/**
 * Log completionItem/resolve request details for debugging.
 * This is called when the client wants more details about a completion item.
 */
function logCompletionResolveRequest(msg: JsonRpcMessage): void {
  const label = msg.params?.label || "(unknown)";
  const kind = msg.params?.kind;
  const kindNames = [
    "", "Text", "Method", "Function", "Constructor", "Field", "Variable",
    "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum",
    "Keyword", "Snippet", "Color", "File", "Reference", "Folder",
    "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"
  ];

  let logMsg = `completionItem/resolve id=${msg.id} label="${label}"`;
  if (kind && kindNames[kind]) {
    logMsg += ` kind=${kindNames[kind]}`;
  }

  log("COMPLETION", logMsg);

  // Track the request for response correlation
  if (msg.id !== undefined) {
    pendingRequests.set(msg.id, {
      method: "completionItem/resolve",
      timestamp: Date.now(),
      context: label,
    });
  }
}

/**
 * Log completion response details for debugging.
 * Called when we receive a response to a completion request.
 */
function logCompletionResponse(msg: JsonRpcMessage, pending: PendingRequest): void {
  const elapsed = Date.now() - pending.timestamp;

  if (msg.error) {
    log("COMPLETION", `Response id=${msg.id} ERROR: ${msg.error.code} - ${msg.error.message} (${elapsed}ms)`);
    return;
  }

  if (pending.method === "textDocument/completion") {
    // Response can be CompletionItem[] or CompletionList
    let itemCount = 0;
    let isIncomplete = false;

    if (Array.isArray(msg.result)) {
      itemCount = msg.result.length;
    } else if (msg.result && typeof msg.result === "object") {
      itemCount = msg.result.items?.length || 0;
      isIncomplete = msg.result.isIncomplete || false;
    }

    log("COMPLETION", `Response id=${msg.id} items=${itemCount} incomplete=${isIncomplete} (${elapsed}ms)`);

    // Log first few items for debugging (only if we have items)
    if (itemCount > 0 && Array.isArray(msg.result)) {
      const labels = msg.result.slice(0, 5).map((i: any) => i.label).join(", ");
      log("COMPLETION", `  First items: ${labels}${itemCount > 5 ? ", ..." : ""}`);
    } else if (itemCount > 0 && msg.result?.items) {
      const labels = msg.result.items.slice(0, 5).map((i: any) => i.label).join(", ");
      log("COMPLETION", `  First items: ${labels}${itemCount > 5 ? ", ..." : ""}`);
    }
  } else if (pending.method === "completionItem/resolve") {
    const label = msg.result?.label || pending.context;
    const hasDocumentation = !!(msg.result?.documentation);
    const hasDetail = !!(msg.result?.detail);

    log("COMPLETION", `Resolve id=${msg.id} label="${label}" hasDoc=${hasDocumentation} hasDetail=${hasDetail} (${elapsed}ms)`);
  }
}

// ---------------------------------------------------------------------------
// Code Action request logging
// ---------------------------------------------------------------------------

/**
 * Log code action request details for debugging.
 * These requests are forwarded to the server without modification.
 */
function logCodeActionRequest(msg: JsonRpcMessage): void {
  const uri = msg.params?.textDocument?.uri || "(unknown)";
  const range = msg.params?.range;
  const context = msg.params?.context;
  const diagnosticsCount = context?.diagnostics?.length || 0;
  const requestedKinds = context?.only?.join(", ") || "all";

  let logMsg = `textDocument/codeAction id=${msg.id} uri=${uri}`;
  if (range) {
    logMsg += ` range=${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
  }
  logMsg += ` diagnostics=${diagnosticsCount} kinds=${requestedKinds}`;

  log("CODE-ACTION", logMsg);

  // Track the request for response correlation
  if (msg.id !== undefined) {
    pendingRequests.set(msg.id, {
      method: "textDocument/codeAction",
      timestamp: Date.now(),
      context: uri,
    });
  }
}

/**
 * Log code action resolve request details for debugging.
 * These requests are forwarded to the server without modification.
 */
function logCodeActionResolveRequest(msg: JsonRpcMessage): void {
  const title = msg.params?.title || "(unknown)";
  const kind = msg.params?.kind || "(unknown)";
  const isPreferred = msg.params?.isPreferred ? " [preferred]" : "";

  log("CODE-ACTION", `codeAction/resolve id=${msg.id} title="${title}" kind=${kind}${isPreferred}`);

  // Track the request for response correlation
  if (msg.id !== undefined) {
    pendingRequests.set(msg.id, {
      method: "codeAction/resolve",
      timestamp: Date.now(),
      context: title,
    });
  }
}

/**
 * Log code action response details for debugging.
 */
function logCodeActionResponse(msg: JsonRpcMessage, pending: PendingRequest): void {
  const elapsed = Date.now() - pending.timestamp;

  if (msg.error) {
    log("CODE-ACTION", `Response id=${msg.id} ERROR: ${msg.error.code} - ${msg.error.message} (${elapsed}ms)`);
    return;
  }

  if (pending.method === "codeAction/resolve") {
    // Resolved code action response
    if (msg.result) {
      const hasEdit = msg.result.edit ? "edit=yes" : "edit=no";
      const hasCommand = msg.result.command ? "command=yes" : "command=no";
      log("CODE-ACTION", `Resolve id=${msg.id} title="${pending.context}" ${hasEdit} ${hasCommand} (${elapsed}ms)`);
    } else {
      log("CODE-ACTION", `Resolve id=${msg.id} title="${pending.context}" result=null (${elapsed}ms)`);
    }
    return;
  }

  // textDocument/codeAction response
  if (msg.result === null) {
    log("CODE-ACTION", `Response id=${msg.id} result=null (no code actions) (${elapsed}ms)`);
    return;
  }

  if (Array.isArray(msg.result)) {
    const actions = msg.result;
    const actionCount = actions.length;

    if (actionCount === 0) {
      log("CODE-ACTION", `Response id=${msg.id} actions=0 (${elapsed}ms)`);
      return;
    }

    // Summarize the code actions
    const kinds = actions
      .map((a: any) => a.kind || "unknown")
      .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i);
    const preferredCount = actions.filter((a: any) => a.isPreferred).length;

    log("CODE-ACTION", `Response id=${msg.id} actions=${actionCount} kinds=[${kinds.join(", ")}] preferred=${preferredCount} (${elapsed}ms)`);

    // Log individual actions (first 5)
    actions.slice(0, 5).forEach((action: any, idx: number) => {
      const title = action.title || "(no title)";
      const kind = action.kind || "unknown";
      const preferred = action.isPreferred ? " [preferred]" : "";
      const disabled = action.disabled ? ` [disabled: ${action.disabled.reason}]` : "";
      log("CODE-ACTION", `  [${idx + 1}] "${title}" (${kind})${preferred}${disabled}`);
    });

    if (actionCount > 5) {
      log("CODE-ACTION", `  ... and ${actionCount - 5} more action(s)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialize request patching
// ---------------------------------------------------------------------------

/**
 * Patch the `initialize` request to advertise dynamic registration support
 * so the language server knows it can use these features.
 */
function patchInitializeRequest(msg: JsonRpcMessage): JsonRpcMessage {
  if (msg.method !== "initialize") return msg;

  // Capture workspace root for v4 auto-detection
  const rootUri = msg.params?.rootUri || msg.params?.rootPath;
  if (rootUri) {
    // Convert file:// URI to path
    let rawPath: string;
    if (rootUri.startsWith("file://")) {
      rawPath = decodeURIComponent(rootUri.replace("file://", ""));
    } else {
      rawPath = rootUri;
    }

    // Security: Validate workspace path to prevent path traversal
    const validatedPath = validateWorkspacePath(rawPath);
    if (validatedPath) {
      workspaceRoot = validatedPath;
      log("INIT", `Workspace root: ${workspaceRoot}`);

      // Trigger v4 detection (async-ish, will cache result)
      detectTailwindV4Entrypoint();
    } else {
      log("INIT", `Workspace root rejected (security): ${rawPath}`);
    }
  }

  const params = msg.params || {};
  const capabilities = params.capabilities || {};
  const workspace = capabilities.workspace || {};
  const textDocument = capabilities.textDocument || {};

  // Advertise dynamic registration support
  workspace.didChangeConfiguration = {
    ...workspace.didChangeConfiguration,
    dynamicRegistration: true,
  };
  workspace.configuration = true;
  workspace.workspaceFolders = true;
  workspace.didChangeWatchedFiles = {
    ...workspace.didChangeWatchedFiles,
    dynamicRegistration: true,
  };

  // Text document capabilities with dynamic registration
  textDocument.completion = {
    ...textDocument.completion,
    dynamicRegistration: true,
    completionItem: {
      ...textDocument.completion?.completionItem,
      snippetSupport: true,
      documentationFormat: ["markdown", "plaintext"],
    },
  };
  textDocument.hover = {
    ...textDocument.hover,
    dynamicRegistration: true,
    contentFormat: ["markdown", "plaintext"],
  };
  textDocument.colorProvider = {
    ...textDocument.colorProvider,
    dynamicRegistration: true,
  };
  textDocument.codeAction = {
    ...textDocument.codeAction,
    dynamicRegistration: true,
    codeActionLiteralSupport: {
      codeActionKind: {
        valueSet: [
          "", // All code actions
          "quickfix",
          "quickfix.extractVariable",
          "quickfix.extractFunction",
          "refactor",
          "refactor.extract",
          "refactor.inline",
          "refactor.rewrite",
          "source",
          "source.organizeImports",
          "source.fixAll",
          "source.sortImports",
        ],
      },
    },
    resolveSupport: {
      properties: ["edit", "command", "documentation", "detail"],
    },
    dataSupport: true,
    isPreferredSupport: true,
    disabledSupport: true,
    honorsChangeAnnotations: true,
  };
  textDocument.diagnostic = {
    ...textDocument.diagnostic,
    dynamicRegistration: true,
  };

  // Formatting capabilities
  textDocument.formatting = {
    ...textDocument.formatting,
    dynamicRegistration: true,
  };
  textDocument.rangeFormatting = {
    ...textDocument.rangeFormatting,
    dynamicRegistration: true,
  };

  // Rename capabilities
  textDocument.rename = {
    ...textDocument.rename,
    dynamicRegistration: true,
    prepareSupport: true,
    prepareSupportDefaultBehavior: 1, // Identifier
    honorsChangeAnnotations: false,
  };

  // Window capabilities
  capabilities.window = {
    ...capabilities.window,
    workDoneProgress: true,
  };

  params.capabilities = { ...capabilities, workspace, textDocument };
  return { ...msg, params };
}

// ---------------------------------------------------------------------------
// Main proxy logic
// ---------------------------------------------------------------------------

function main(): void {
  // Spawn the actual Tailwind CSS language server
  log("INFO", `Starting: ${SERVER_COMMAND} ${SERVER_ARGS.join(" ")}`);

  const serverProcess: ChildProcess = spawn(SERVER_COMMAND, SERVER_ARGS, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (!serverProcess.stdin || !serverProcess.stdout) {
    process.stderr.write(
      `Failed to spawn ${SERVER_COMMAND}. Is it installed?\n` +
        `Install with: npm install -g @tailwindcss/language-server\n`
    );
    process.exit(1);
  }

  // Log server stderr
  serverProcess.stderr?.on("data", (data: Buffer) => {
    log("SERVER-ERR", data.toString("utf-8").trim());
  });

  serverProcess.on("error", (err) => {
    process.stderr.write(
      `Failed to start ${SERVER_COMMAND}: ${err.message}\n` +
        `Is @tailwindcss/language-server installed?\n` +
        `Install with: npm install -g @tailwindcss/language-server\n`
    );
    process.exit(1);
  });

  serverProcess.on("exit", (code, signal) => {
    log("INFO", `Server exited with code ${code}, signal ${signal}`);
    process.exit(code ?? 1);
  });

  // Message buffers for parsing JSON-RPC from streams
  const clientBuffer = new MessageBuffer(); // Claude Code -> adapter
  const serverBuffer = new MessageBuffer(); // tailwindcss-ls -> adapter

  // -----------------------------------------------------------------------
  // Client -> Server direction (Claude Code -> Tailwind LSP)
  // -----------------------------------------------------------------------
  process.stdin.on("data", (data: Buffer) => {
    const messages = clientBuffer.feed(data);
    for (const msg of messages) {
      log("CLIENT->", JSON.stringify(msg).substring(0, 500));

      // Patch initialize to advertise dynamic registration
      const patched = patchInitializeRequest(msg);

      // Log requests for debugging
      switch (msg.method) {
        case "textDocument/completion":
          logCompletionRequest(msg);
          break;
        case "completionItem/resolve":
          logCompletionResolveRequest(msg);
          break;
        case "textDocument/formatting":
          logFormattingRequest(msg);
          break;
        case "textDocument/rangeFormatting":
          logRangeFormattingRequest(msg);
          break;
        case "textDocument/prepareRename":
          logPrepareRenameRequest(msg);
          break;
        case "textDocument/rename":
          logRenameRequest(msg);
          break;
        case "textDocument/codeAction":
          logCodeActionRequest(msg);
          break;
        case "codeAction/resolve":
          logCodeActionResolveRequest(msg);
          break;
      }

      // Forward to server
      serverProcess.stdin!.write(encodeMessage(patched));
    }
  });

  // -----------------------------------------------------------------------
  // Server -> Client direction (Tailwind LSP -> Claude Code)
  // -----------------------------------------------------------------------
  serverProcess.stdout.on("data", (data: Buffer) => {
    const messages = serverBuffer.feed(data);
    for (const msg of messages) {
      log("SERVER->", JSON.stringify(msg).substring(0, 500));

      // Intercept server-to-client requests that Claude Code can't handle
      if (msg.method && msg.id !== undefined) {
        let response: JsonRpcMessage | null = null;

        switch (msg.method) {
          case "client/registerCapability":
            response = handleRegisterCapability(msg);
            break;
          case "client/unregisterCapability":
            response = handleUnregisterCapability(msg);
            break;
          case "workspace/configuration":
            response = handleWorkspaceConfiguration(msg);
            break;
          case "window/workDoneProgress/create":
            response = handleWorkDoneProgressCreate(msg);
            break;
        }

        if (response) {
          // Send response back to the server (not to Claude Code)
          log("RESPOND->SERVER", JSON.stringify(response).substring(0, 500));
          serverProcess.stdin!.write(encodeMessage(response));
          continue; // Don't forward to client
        }
      }

      // Intercept notifications we want to absorb
      if (msg.method && msg.id === undefined) {
        switch (msg.method) {
          case "$/progress":
            // Absorb progress notifications — Claude Code doesn't use them
            log("INTERCEPT", `Progress: ${JSON.stringify(msg.params).substring(0, 200)}`);
            continue;
          case "window/logMessage":
            log("INTERCEPT", `LogMessage: ${msg.params?.message?.substring(0, 200)}`);
            continue;
        }
      }

      // Log responses for tracked requests (completion, formatting, rename)
      if ((msg.result !== undefined || msg.error !== undefined) && msg.id !== undefined) {
        // Check if this is a response to a tracked completion request
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          if (pending.method === "textDocument/completion" || pending.method === "completionItem/resolve") {
            logCompletionResponse(msg, pending);
          } else if (pending.method === "textDocument/codeAction" || pending.method === "codeAction/resolve") {
            logCodeActionResponse(msg, pending);
          }
          pendingRequests.delete(msg.id);
        }

        // Log successful formatting responses
        if (msg.result && Array.isArray(msg.result)) {
          const editsCount = msg.result.length;
          if (editsCount > 0 && msg.result[0]?.range && msg.result[0]?.newText !== undefined) {
            log("RESPONSE", `Formatting/rename response with ${editsCount} edit(s)`);
          }
        }
        // Log error responses (if not already logged by completion handler)
        if (msg.error && !pending) {
          log("ERROR", `Response error: ${msg.error.code} - ${msg.error.message}`);
        }
      }

      // Forward everything else to Claude Code
      process.stdout.write(encodeMessage(msg));
    }
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------
  process.stdin.on("end", () => {
    log("INFO", "Client stdin closed, shutting down server");
    serverProcess.kill("SIGTERM");
    setTimeout(() => {
      serverProcess.kill("SIGKILL");
    }, 3000);
  });

  process.on("SIGTERM", () => {
    log("INFO", "Received SIGTERM");
    serverProcess.kill("SIGTERM");
  });

  process.on("SIGINT", () => {
    log("INFO", "Received SIGINT");
    serverProcess.kill("SIGTERM");
  });
}

// ---------------------------------------------------------------------------
// Setup CLI Command
// ---------------------------------------------------------------------------

interface SetupPaths {
  // Base directories
  claudePluginsDir: string;
  marketplaceDir: string;       // ~/.claude/plugins/local-plugins
  marketplaceConfigDir: string; // ~/.claude/plugins/local-plugins/.claude-plugin
  marketplaceJson: string;      // ~/.claude/plugins/local-plugins/.claude-plugin/marketplace.json

  // Plugin directories (inside marketplace)
  pluginDir: string;            // ~/.claude/plugins/local-plugins/tailwind-lsp-adapter
  pluginConfigDir: string;      // ~/.claude/plugins/local-plugins/tailwind-lsp-adapter/.claude-plugin
  pluginJson: string;           // ~/.claude/plugins/local-plugins/tailwind-lsp-adapter/.claude-plugin/plugin.json
  lspJson: string;              // ~/.claude/plugins/local-plugins/tailwind-lsp-adapter/.lsp.json

  // Known marketplaces file
  knownMarketplacesJson: string; // ~/.claude/plugins/known_marketplaces.json
}

function getSetupPaths(): SetupPaths {
  const homeDir = os.homedir();
  const claudePluginsDir = resolve(homeDir, ".claude/plugins");
  const marketplaceDir = resolve(claudePluginsDir, "local-plugins");
  const marketplaceConfigDir = resolve(marketplaceDir, ".claude-plugin");
  const pluginDir = resolve(marketplaceDir, "tailwind-lsp-adapter");
  const pluginConfigDir = resolve(pluginDir, ".claude-plugin");

  return {
    claudePluginsDir,
    marketplaceDir,
    marketplaceConfigDir,
    marketplaceJson: resolve(marketplaceConfigDir, "marketplace.json"),
    pluginDir,
    pluginConfigDir,
    pluginJson: resolve(pluginConfigDir, "plugin.json"),
    lspJson: resolve(pluginDir, ".lsp.json"),
    knownMarketplacesJson: resolve(claudePluginsDir, "known_marketplaces.json"),
  };
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    console.log(`  Created directory: ${dirPath}`);
  }
}

function writeJsonFile(filePath: string, data: object, _description: string): void {
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o644 });
  console.log(`  Created/updated: ${filePath}`);
}

function createPluginJson(paths: SetupPaths): void {
  console.log("\n[1/4] Creating plugin.json...");
  ensureDirectory(paths.pluginConfigDir);

  // plugin.json must be minimal - only name, version, description, author
  // All other keys (category, strict, lspServers, etc.) go in marketplace.json
  const pluginJson = {
    name: "tailwind-lsp-adapter",
    version: "1.0.0",
    description: "Tailwind CSS LSP Adapter for Claude Code - provides diagnostics and hover for Tailwind classes",
    author: {
      name: "CommerceMax",
      email: "local@localhost",
    },
  };

  writeJsonFile(paths.pluginJson, pluginJson, "plugin.json");
}

function createLspJson(paths: SetupPaths): void {
  console.log("\n[2/4] Creating .lsp.json...");
  ensureDirectory(paths.pluginDir);

  const lspJson = {
    servers: {
      tailwindcss: {
        command: "tailwind-lsp-adapter",
        args: [],
        filetypes: [
          "css",
          "scss",
          "less",
          "html",
          "javascript",
          "javascriptreact",
          "typescript",
          "typescriptreact",
          "vue",
          "svelte",
        ],
        rootPatterns: [
          "tailwind.config.js",
          "tailwind.config.ts",
          "tailwind.config.cjs",
          "tailwind.config.mjs",
          "postcss.config.js",
          "postcss.config.ts",
          "postcss.config.cjs",
          "postcss.config.mjs",
          "package.json",
        ],
        initializationOptions: {},
        settings: {
          tailwindCSS: {
            emmetCompletions: false,
            classAttributes: ["class", "className", "ngClass"],
            lint: {
              cssConflict: "warning",
              invalidApply: "error",
              invalidScreen: "error",
              invalidVariant: "error",
              invalidConfigPath: "error",
              invalidTailwindDirective: "error",
              recommendedVariantOrder: "warning",
            },
            showPixelEquivalents: true,
            rootFontSize: 16,
          },
        },
      },
    },
  };

  writeJsonFile(paths.lspJson, lspJson, ".lsp.json");
}

interface MarketplacePlugin {
  name: string;
  description: string;
  version: string;
  author?: { name: string; email: string };
  source: string;
  category?: string;
  strict?: boolean;
  lspServers?: Record<string, {
    command: string;
    args: string[];
    extensionToLanguage: Record<string, string>;
  }>;
}

interface MarketplaceJson {
  $schema: string;
  name: string;
  description: string;
  owner: { name: string; email: string };
  plugins: MarketplacePlugin[];
}

function createOrUpdateMarketplaceJson(paths: SetupPaths): void {
  console.log("\n[3/4] Creating/updating marketplace.json...");
  ensureDirectory(paths.marketplaceConfigDir);

  let marketplace: MarketplaceJson = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name: "local-plugins",
    description: "Local plugin marketplace for custom extensions",
    owner: {
      name: "Local",
      email: "local@localhost",
    },
    plugins: [],
  };

  // Read existing marketplace.json if it exists
  if (fs.existsSync(paths.marketplaceJson)) {
    try {
      const existing = JSON.parse(fs.readFileSync(paths.marketplaceJson, "utf-8"));
      if (existing && existing.$schema && Array.isArray(existing.plugins)) {
        marketplace = existing;
      }
    } catch {
      console.log("  Warning: Could not parse existing marketplace.json, creating new one");
    }
  }

  // Check if tailwind-lsp-adapter is already registered
  const existingIndex = marketplace.plugins.findIndex(
    (p) => p.name === "tailwind-lsp-adapter"
  );

  const pluginEntry: MarketplacePlugin = {
    name: "tailwind-lsp-adapter",
    description: "Tailwind CSS LSP Adapter for Claude Code - provides intelligent CSS completions, hover info, and diagnostics",
    version: "1.0.0",
    author: {
      name: "Tailwind LSP Adapter",
      email: "local@localhost",
    },
    source: "./tailwind-lsp-adapter",
    category: "development",
    strict: false,
    lspServers: {
      tailwindcss: {
        command: "tailwind-lsp-adapter",
        args: [],
        extensionToLanguage: {
          ".css": "css",
          ".scss": "scss",
          ".less": "less",
          ".html": "html",
          ".js": "javascript",
          ".jsx": "javascriptreact",
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".vue": "vue",
          ".svelte": "svelte",
        },
      },
    },
  };

  if (existingIndex >= 0) {
    marketplace.plugins[existingIndex] = pluginEntry;
    console.log("  Updated existing tailwind-lsp-adapter entry");
  } else {
    marketplace.plugins.push(pluginEntry);
    console.log("  Added tailwind-lsp-adapter to marketplace");
  }

  writeJsonFile(paths.marketplaceJson, marketplace, "marketplace.json");
}

interface KnownMarketplaceEntry {
  source: {
    source: string;
    path?: string;
    repo?: string;
  };
  installLocation: string;
  lastUpdated: string;
}

function updateKnownMarketplaces(paths: SetupPaths): void {
  console.log("\n[4/4] Updating known_marketplaces.json...");
  ensureDirectory(paths.claudePluginsDir);

  let knownMarketplaces: Record<string, KnownMarketplaceEntry> = {};

  // Read existing known_marketplaces.json if it exists
  if (fs.existsSync(paths.knownMarketplacesJson)) {
    try {
      knownMarketplaces = JSON.parse(fs.readFileSync(paths.knownMarketplacesJson, "utf-8"));
    } catch {
      console.log("  Warning: Could not parse existing known_marketplaces.json, creating new one");
      knownMarketplaces = {};
    }
  }

  const marketplaceName = "local-plugins";

  const marketplaceEntry: KnownMarketplaceEntry = {
    source: {
      source: "directory",
      path: paths.marketplaceDir,
    },
    installLocation: paths.marketplaceDir,
    lastUpdated: new Date().toISOString(),
  };

  if (knownMarketplaces[marketplaceName]) {
    console.log("  Updated existing local-plugins marketplace entry");
  } else {
    console.log("  Added local-plugins to known_marketplaces.json");
  }

  knownMarketplaces[marketplaceName] = marketplaceEntry;
  writeJsonFile(paths.knownMarketplacesJson, knownMarketplaces, "known_marketplaces.json");
}

function printInstructions(): void {
  const homeDir = os.homedir();
  console.log("\n" + "=".repeat(60));
  console.log("Setup Complete!");
  console.log("=".repeat(60));
  console.log("\nCreated files:");
  console.log(`  - ${homeDir}/.claude/plugins/local-plugins/.claude-plugin/marketplace.json`);
  console.log(`  - ${homeDir}/.claude/plugins/local-plugins/tailwind-lsp-adapter/.claude-plugin/plugin.json`);
  console.log(`  - ${homeDir}/.claude/plugins/local-plugins/tailwind-lsp-adapter/.lsp.json`);
  console.log(`  - ${homeDir}/.claude/plugins/known_marketplaces.json (updated)`);
  console.log("\nNext steps:");
  console.log("\n1. Enable LSP tools in Claude Code by setting the environment variable:");
  console.log("   export ENABLE_LSP_TOOL=1");
  console.log("\n   Or add it to your shell profile (~/.bashrc, ~/.zshrc, etc.):");
  console.log("   echo 'export ENABLE_LSP_TOOL=1' >> ~/.zshrc");
  console.log("\n2. Restart Claude Code to pick up the settings changes.");
  console.log("\n3. In Claude Code, install the plugin:");
  console.log("   /plugin install tailwind-lsp-adapter@local-plugins");
  console.log("\n4. Ensure @tailwindcss/language-server is installed globally:");
  console.log("   npm install -g @tailwindcss/language-server");
  console.log("\n5. (Optional) For debug logging, set:");
  console.log("   export LSP_ADAPTER_DEBUG=1");
  console.log("\n" + "=".repeat(60));
}

function runSetup(): void {
  console.log("Tailwind LSP Adapter - Setup");
  console.log("============================");
  console.log("\nThis will configure Claude Code to use the Tailwind LSP Adapter.");

  const paths = getSetupPaths();

  try {
    createPluginJson(paths);
    createLspJson(paths);
    createOrUpdateMarketplaceJson(paths);
    updateKnownMarketplaces(paths);
    printInstructions();
    process.exit(0);
  } catch (err) {
    console.error("\nSetup failed:", err instanceof Error ? err.message : String(err));
    console.error("\nPlease check file permissions and try again.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

// Check for --setup flag before starting the LSP adapter
if (process.argv.includes("--setup")) {
  runSetup();
} else {
  main();
}
