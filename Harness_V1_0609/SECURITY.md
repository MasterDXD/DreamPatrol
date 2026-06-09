# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.7.x   | :white_check_mark: |
| 2.1.x   | :white_check_mark: |
| 2.0.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security vulnerability in Harness Engineering Framework, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email security reports to the project maintainers
3. Include the following information:
   - Type of vulnerability (e.g., path traversal, injection, privilege escalation)
   - Full paths of source file(s) related to the vulnerability
   - Steps to reproduce
   - Potential impact
   - Possible mitigations (if you have suggestions)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 5 business days
- **Fix Development**: Within 14 business days (critical), 30 days (high), 60 days (medium/low)
- **Disclosure**: After fix is released and users have had time to update

## Security Architecture

### Permission Guard
- All file operations are validated against project root boundary
- Symlink resolution prevents path traversal attacks
- Session IDs are validated with strict regex pattern (`^[a-zA-Z0-9_-]{1,64}$`)
- File-level locks prevent concurrent modification conflicts
- Dangerous command detection with pattern-based filtering
- Confirmation expiry mechanism prevents stale approvals
- **TOCTOU fix for non-existent files** (`permission-guard.js`): When `fs.realpathSync()` fails with `ENOENT`/`ENOTDIR` (file does not yet exist), the guard resolves the parent directory via `fs.realpathSync()`, then reconstructs the verified path via `path.join(realParent, path.basename(resolved))` and checks the resulting relative path against the project root — prevents TOCTOU race where an attacker could create a symlink between the existence check and the access

### RBAC Enforcement
- Agent permissions are loaded from `.harness/agents/` definitions
- Skill execution requires explicit permission check
- Strict enforcement skills cannot be bypassed
- Skill execution order is validated against dependency graph
- Three enforcement levels: strict / recommended / optional
- **Atomic all-or-nothing loading** (`rbac-enforcer.js`): `load()` builds new `agents`, `agentSkillSets`, and `skills` maps into temporary variables first; only if `_loadErrors.length === 0` are they assigned to `this.agents` / `this._agentSkillSets` / `this.skills` — if any load error occurs, the old (previously valid) permissions are retained, preventing partial loads from creating permission bypass gaps

### TDD Gate
- Implementation without corresponding test is blocked
- Coverage thresholds are enforced numerically (validated input)
- TDD cycle history is bounded (max 100 entries per task)
- Framework compliance checks enforce naming/structure/security rules

### Audit Logging
- All permission checks are logged with timestamps
- Memory-bounded log (max 10,000 entries with FIFO eviction)
- Logs can be exported for external analysis
- **Chain hash integrity verification** (`audit-logger.js`): SHA-256 chain hash ensures log tampering is detectable
  - Each log entry's hash depends on the previous entry's hash — forming a cryptographic chain where modifying any single entry invalidates all subsequent hashes
  - `_computeEntryHash()` computes `SHA-256(sequence + timestamp + agent + action + target + result + reason + details + responsibility + previousHash)` via `sha256Hex()`
  - `_buildHashData()` encodes all entry fields plus `prevHash` into a URL-encoded string before hashing
  - On load, `_restoreEntries()` verifies each entry's hash against the recomputed expected hash; entries with mismatched hashes are silently discarded
  - `_lastHash` tracks the chain tip; `verifyIntegrity()` walks the full chain and returns `{ total, tampered, tamperedIndices, valid }`
  - Tamper detection: any modification to an entry's fields or hash, or deletion/reordering of entries, breaks the chain and is reported via the `integrity-violation` event
- Debounced persistence for performance-safe writes
- **Field truncation** (`audit-logger.js`): `MAX_DETAIL_LENGTH=10000` and `MAX_FIELD_LENGTH=1000` constants enforce maximum lengths on all logged fields (`agent`, `action`, `target`, `result`, `reason`, `details`, `responsibility`) via `_truncateField()` — prevents unbounded log entries from causing memory exhaustion or storage abuse

### MCP Client Security
- **SSRF protection — private IP detection** (`network-utils.js`): Blocks RFC 1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), IPv6 unique local (`fc00::/7`), IPv4-mapped IPv6 (`::ffff:`), cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, `metadata.azure.com`, `100.100.100.200`); octal and hexadecimal IP representations are also rejected
- **SSRF protection — URL allowlist** (`mcp-security.js`): `validateMcpUrl()` restricts protocols to `http:` / `https:` only; `validateMcpHostname()` performs exact-match against `BLOCKED_HOSTS` and pattern-match against `BLOCKED_HOST_PATTERNS`; `validateMcpCommand()` enforces a command allowlist (`MCP_ALLOWED_COMMANDS`) with dangerous argument filtering (`MCP_DANGEROUS_ARG_PATTERNS`)
- **SSRF protection — DNS rebinding prevention** (`mcp-client.js`): Custom `_safeLookup()` DNS resolver intercepts resolved addresses and blocks those resolving to private IPs, preventing DNS rebinding attacks that bypass hostname-level checks
- **Request size limits**: `MCP_HTTP_MAX_BODY_SIZE` (10 MB) for outbound requests; `MCP_HTTP_MAX_RESPONSE_SIZE` (10 MB) for inbound responses; `MCP_STDIO_MAX_BUFFER` (1 MB) for stdio transport; `MAX_POST_ARGS_COUNT` / `MAX_POST_ARG_LENGTH` / `MAX_POST_URL_LENGTH` for API input validation
- **Process exit cleanup** (`mcp-client.js`): `_onShutdown()` terminates all stdio child processes (SIGTERM → SIGKILL after 5s), cancels pending requests, removes all listeners, and clears buffers — ensures no orphaned child processes remain

### Input Sanitization
- XSS protection via HTML sanitization
- SQL injection prevention through parameterized queries
- Path traversal prevention with boundary validation
- All external inputs validated before processing

### Prototype Pollution Protection
- `DANGEROUS_KEYS` in `constants.js`: Global `Set` of `__proto__`, `constructor`, `prototype`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` — used as the single source of truth across all sanitization modules
- `sanitizeObject()` / `sanitizeProto()` in `sanitizer.js`: Recursive removal of dangerous keys using `Object.create(null)` to produce prototype-free objects; circular reference detection via `WeakSet`; depth limits (5 for `sanitizeProto`, 10 for `sanitizeObject`)
- `safeAssign()` in `safe-assign.js`: Drop-in replacement for `Object.assign()` that filters dangerous keys during property copy; also provides `mergeConfig()` for safe default-option merging
- `safeJsonParse()` / `safeParse()` in `safe-parse.js`: JSON parsing with 50 MB length limit and automatic `sanitizeObject()` on all parsed objects — neutralizes `{"__proto__": {"admin": true}}` payloads at the parsing boundary
- `deepClone()` in `deep-clone.js`: Deep cloning with `DANGEROUS_KEYS_SET` filtering; prefers native `structuredClone`, falls back to JSON clone with dangerous key exclusion
- `DebouncedPersister._sanitize()` in `debounced-persister.js`: Data sanitization before persistence — deep clones then strips dangerous keys recursively, ensuring no prototype-polluting keys reach disk
- **Defense-in-depth approach**: Multiple independent layers form a complete pipeline — parsing (`safe-parse`) → cloning (`deep-clone`) → assignment (`safe-assign`) → sanitization (`sanitizer`) → persistence (`debounced-persister`). A payload must breach every layer to succeed

### HTTP Server Security
- CSP nonce for inline script/style protection
- Rate limiting on API endpoints
- CORS configuration with origin validation
- Compression bomb protection (size limits)
- **API parameter enum validation** (`agent-data.js`): Query parameters for `state`, `type`, `resource`, `level`, `env` are validated against `Set`-based enum whitelists (`VALID_WORKFLOW_TASK_STATES`, `VALID_WORKFLOW_TRIGGER_TYPES`, `VALID_SANDBOX_RESOURCES`, `VALID_ALERT_LEVELS`, `VALID_LOG_LEVELS`, `VALID_DEPLOYMENT_ENVS`, `VALID_DEPLOYMENT_STATES`) via `_validateEnum()` — invalid values are rejected rather than passed through to downstream modules
- **WebSocket protocol header validation** (`websocket-handler.js`): Only `bearer-*` and `sha256-*` protocol prefixes are echoed in the `Sec-WebSocket-Protocol` response header; `\r\n` characters in the requested protocol are rejected to prevent HTTP response splitting / header injection
- **WebSocket message handler error separation** (`websocket-handler.js`): Parse errors (`messageParse`) and handler errors (`messageHandlerError`) are logged as separate debug categories — parse errors indicate malformed/attack payloads and are not confused with application-level handler failures, improving incident analysis accuracy

### Data Storage Security
- SQLite WAL mode for crash-safe writes
- No sensitive data in logs (filtered by debug-logger)
- Encryption at rest recommended for production deployments

> For detailed security architecture, see [核心功能-权限控制与审计](docs/core/核心功能-权限控制与审计.md) and [深度拆解-权限执行引擎与安全防护](docs/deep-dive/深度拆解-权限执行引擎与安全防护.md).

## Known Security Considerations

1. **Agent Identity**: The current implementation trusts the `agentId` parameter provided by callers. In production environments, consider adding authentication middleware.
2. **Command Detection**: The `PermissionGuard.checkCommand()` uses pattern-based detection for dangerous commands. This is a best-effort approach and may not catch all variants. Consider using a whitelist approach for production.
3. **File System Access**: The framework operates within the project root but does not encrypt data at rest. Ensure proper file system permissions are set.
