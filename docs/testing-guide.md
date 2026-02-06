# Tailwind LSP Adapter Testing Guide

## Overview

This document provides a comprehensive testing strategy for the `tailwind-lsp-adapter`, a transparent proxy between Claude Code and `@tailwindcss/language-server`.

## Test Environment Setup

### Prerequisites

```bash
# Install dependencies
npm install

# Install Tailwind LSP server globally
npm install -g @tailwindcss/language-server

# Build the adapter
npm run build
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LSP_ADAPTER_DEBUG` | Enable debug logging (set to "1") | disabled |
| `TAILWIND_LSP_COMMAND` | Custom LSP server command | `tailwindcss-language-server` |
| `TAILWIND_LSP_ARGS` | Server arguments | `--stdio` |
| `TAILWIND_CSS_ENTRYPOINT` | CSS entrypoint for Tailwind v4 | auto-detected |

## Test Categories

### 1. Unit Tests

#### Message Buffer Parsing

Test the `MessageBuffer` class for JSON-RPC message parsing:

```typescript
describe('MessageBuffer', () => {
  it('should parse complete messages', () => {
    const buffer = new MessageBuffer();
    const message = { jsonrpc: "2.0", id: 1, method: "test" };
    const encoded = encodeMessage(message);

    const parsed = buffer.feed(encoded);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(message);
  });

  it('should handle fragmented messages', () => {
    const buffer = new MessageBuffer();
    const message = { jsonrpc: "2.0", id: 1, method: "test" };
    const encoded = encodeMessage(message);

    // Feed in chunks
    const chunk1 = encoded.subarray(0, 10);
    const chunk2 = encoded.subarray(10);

    expect(buffer.feed(chunk1)).toHaveLength(0);
    expect(buffer.feed(chunk2)).toHaveLength(1);
  });

  it('should handle multiple messages in one chunk', () => {
    const buffer = new MessageBuffer();
    const msg1 = { jsonrpc: "2.0", id: 1, method: "test1" };
    const msg2 = { jsonrpc: "2.0", id: 2, method: "test2" };

    const combined = Buffer.concat([encodeMessage(msg1), encodeMessage(msg2)]);
    const parsed = buffer.feed(combined);

    expect(parsed).toHaveLength(2);
  });

  it('should reject malformed headers', () => {
    const buffer = new MessageBuffer();
    const malformed = Buffer.from('Invalid-Header: foo\r\n\r\n{}');

    const parsed = buffer.feed(malformed);

    expect(parsed).toHaveLength(0);
  });
});
```

#### Intercepted Method Handlers

```typescript
describe('handleRegisterCapability', () => {
  it('should respond with null result', () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "client/registerCapability",
      params: {
        registrations: [
          { id: "reg-1", method: "textDocument/completion" }
        ]
      }
    };

    const response = handleRegisterCapability(request);

    expect(response.id).toBe(1);
    expect(response.result).toBeNull();
  });

  it('should track registered capabilities', () => {
    // After handling registration, capability should be tracked
    expect(registeredCapabilities.has("reg-1")).toBe(true);
  });
});

describe('handleWorkspaceConfiguration', () => {
  it('should return Tailwind defaults for tailwindCSS section', () => {
    const request = {
      jsonrpc: "2.0",
      id: 2,
      method: "workspace/configuration",
      params: {
        items: [{ section: "tailwindCSS" }]
      }
    };

    const response = handleWorkspaceConfiguration(request);

    expect(response.result).toHaveLength(1);
    expect(response.result[0]).toHaveProperty('classAttributes');
    expect(response.result[0]).toHaveProperty('lint');
  });

  it('should return empty object for unknown sections', () => {
    const request = {
      jsonrpc: "2.0",
      id: 3,
      method: "workspace/configuration",
      params: {
        items: [{ section: "unknown" }]
      }
    };

    const response = handleWorkspaceConfiguration(request);

    expect(response.result[0]).toEqual({});
  });
});
```

### 2. Integration Tests

#### LSP Protocol Compliance

```typescript
describe('LSP Protocol Integration', () => {
  let adapter: ChildProcess;
  let client: MessageBuffer;

  beforeAll(() => {
    adapter = spawn('node', ['dist/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LSP_ADAPTER_DEBUG: '1' }
    });
    client = new MessageBuffer();
  });

  afterAll(() => {
    adapter.kill();
  });

  it('should handle initialize request', async () => {
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: "file:///test/project",
        capabilities: {}
      }
    };

    adapter.stdin!.write(encodeMessage(initRequest));

    const response = await waitForResponse(adapter.stdout!, client, 1);

    expect(response).toHaveProperty('result');
    expect(response.result).toHaveProperty('capabilities');
  });

  it('should handle textDocument/didOpen', async () => {
    const didOpenNotification = {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri: "file:///test/project/index.html",
          languageId: "html",
          version: 1,
          text: '<div class="bg-blue-500"></div>'
        }
      }
    };

    adapter.stdin!.write(encodeMessage(didOpenNotification));

    // No response expected for notifications
    // Verify no error is thrown
  });
});
```

### 3. End-to-End Tests

#### Claude Code Integration

```bash
#!/bin/bash
# e2e-test.sh - Test adapter with real Claude Code

# Create test project
mkdir -p /tmp/tailwind-test
cd /tmp/tailwind-test
npm init -y
npm install tailwindcss

# Create Tailwind v4 config
cat > src/styles.css << 'EOF'
@import "tailwindcss";
EOF

# Start adapter with debug logging
export LSP_ADAPTER_DEBUG=1
tailwind-lsp-adapter &
ADAPTER_PID=$!

# Send test messages (simplified example)
echo 'Content-Length: 174

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":1234,"rootUri":"file:///tmp/tailwind-test","capabilities":{}}}' | nc localhost $PORT

# Cleanup
kill $ADAPTER_PID
```

### 4. Security Tests

```typescript
describe('Security', () => {
  describe('Server Command Validation', () => {
    it('should reject invalid server commands', () => {
      process.env.TAILWIND_LSP_COMMAND = '/bin/bash -c "echo pwned"';

      expect(() => validateServerCommand(process.env.TAILWIND_LSP_COMMAND))
        .toThrow(/Security.*Invalid LSP command/);
    });

    it('should accept valid server commands', () => {
      const valid = 'tailwindcss-language-server';
      expect(validateServerCommand(valid)).toBe(valid);
    });
  });

  describe('Workspace Path Validation', () => {
    it('should reject forbidden system paths', () => {
      const forbidden = ['/etc', '/usr', '/bin', '/root'];

      for (const path of forbidden) {
        expect(validateWorkspacePath(path)).toBeNull();
      }
    });

    it('should reject path traversal attempts', () => {
      const traversal = '/home/user/../../../etc/passwd';
      expect(validateWorkspacePath(traversal)).toBeNull();
    });

    it('should accept valid workspace paths', () => {
      const valid = '/tmp/my-project';
      // Would need to create dir first in real test
      expect(validateWorkspacePath(valid)).toBe('/tmp/my-project');
    });
  });
});
```

### 5. Performance Tests

```typescript
describe('Performance', () => {
  it('should parse 1000 messages under 100ms', () => {
    const buffer = new MessageBuffer();
    const messages = Array(1000).fill(null).map((_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "test",
      params: { data: "x".repeat(100) }
    }));

    const encoded = Buffer.concat(messages.map(encodeMessage));

    const start = performance.now();
    const parsed = buffer.feed(encoded);
    const duration = performance.now() - start;

    expect(parsed).toHaveLength(1000);
    expect(duration).toBeLessThan(100);
  });

  it('should handle large messages efficiently', () => {
    const buffer = new MessageBuffer();
    const largeMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { data: "x".repeat(1_000_000) } // 1MB
    };

    const start = performance.now();
    const parsed = buffer.feed(encodeMessage(largeMessage));
    const duration = performance.now() - start;

    expect(parsed).toHaveLength(1);
    expect(duration).toBeLessThan(50);
  });
});
```

## Manual Testing Checklist

### Setup Verification

- [ ] Build completes without errors (`npm run build`)
- [ ] Executable is created at `dist/index.js`
- [ ] Shebang is present (`#!/usr/bin/env node`)
- [ ] File permissions allow execution

### LSP Feature Testing

#### Completion (textDocument/completion)

- [ ] Class name completions appear in HTML files
- [ ] Variant completions work (hover:, focus:, etc.)
- [ ] Color completions show color swatches (if supported)
- [ ] Arbitrary value completions work (e.g., `w-[100px]`)

#### Hover (textDocument/hover)

- [ ] Hovering over Tailwind classes shows CSS output
- [ ] Color classes show color preview
- [ ] Complex utilities show complete CSS

#### Diagnostics (textDocument/publishDiagnostics)

- [ ] Invalid class names are highlighted
- [ ] Conflicting utilities are warned
- [ ] Invalid variants are reported

#### Code Actions (textDocument/codeAction)

- [ ] Quick fixes are offered for common issues
- [ ] Sort classes action works (if available)

### Tailwind Version Compatibility

#### Tailwind v3 (Config-based)

- [ ] Works with `tailwind.config.js`
- [ ] Custom theme values are recognized
- [ ] Plugin classes are available

#### Tailwind v4 (CSS-based)

- [ ] Auto-detects `@import "tailwindcss"` in CSS files
- [ ] Works without config file
- [ ] Custom CSS variables are recognized

### Error Handling

- [ ] Graceful handling when Tailwind LSP not installed
- [ ] Proper error message for invalid workspace paths
- [ ] Clean shutdown on SIGTERM/SIGINT

## Debugging

### Enable Debug Logging

```bash
export LSP_ADAPTER_DEBUG=1
tailwind-lsp-adapter
```

Logs are written to: `/tmp/tailwind-lsp-adapter-<pid>-<random>.log`

### Log Format

```
[2024-02-06T12:00:00.000Z] CLIENT-> {"jsonrpc":"2.0","id":1,"method":"initialize"...}
[2024-02-06T12:00:00.001Z] SERVER-> {"jsonrpc":"2.0","id":1,"result":{...}}
[2024-02-06T12:00:00.002Z] INTERCEPT client/registerCapability handled
```

### Common Issues

| Symptom | Possible Cause | Solution |
|---------|----------------|----------|
| No completions | LSP server not installed | `npm i -g @tailwindcss/language-server` |
| Server crashes immediately | Wrong server command | Check `TAILWIND_LSP_COMMAND` |
| v4 not working | CSS entrypoint not found | Set `TAILWIND_CSS_ENTRYPOINT` |
| Permission denied | Log file location | Check `/tmp` permissions |

## Known Limitations

1. **No formatting support** - The adapter does not currently implement `textDocument/formatting`
2. **No rename support** - The adapter does not currently implement `textDocument/rename`
3. **Passthrough architecture** - Most LSP features are passed through to the underlying server

## Recommended Test Framework

```json
{
  "devDependencies": {
    "jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "ts-jest": "^29.0.0"
  },
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

## CI/CD Integration

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - run: npm test
```

## Reporting Issues

When reporting issues, include:

1. Debug log output (with `LSP_ADAPTER_DEBUG=1`)
2. Tailwind CSS version
3. Node.js version
4. Operating system
5. Minimal reproduction case
