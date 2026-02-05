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
  };
  textDocument.diagnostic = {
    ...textDocument.diagnostic,
    dynamicRegistration: true,
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
// Entry
// ---------------------------------------------------------------------------
main();
