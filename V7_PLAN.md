# V7 Plan — Close the CLI Gap, Prepare for Remote Governor

The extension is a CLI wrapper. The CLI has outgrown it. V7 brings the post-extraction subsystems into the IDE and lays groundwork for non-local governor.

---

## What "done" looks like

1. IDE exposes preflight, scope, correlator, kernel verify, oracle evidence, scars
2. Tree views + status bar match CLI reality
3. Capabilities handshake replaces version guessing
4. Remote governor path is unblocked (not fully built, but not precluded)

---

## Architecture: GovernorClient refactor

Before adding features, fix the spawn layer. Current `client.ts` has one-off spawn logic scattered across functions. Refactor to:

```typescript
class GovernorClient {
  constructor(config: GovernorClientConfig) // binary path, cwd, env, transport

  // Core execution
  execJson<T>(args: string[], opts?: ExecOptions): Promise<T>
  execVoid(args: string[]): Promise<void>

  // Transport abstraction (V7.0: CLI only; future: RPC)
  private transport: GovernorTransport  // CLI | RPC (later)

  // Feature detection
  capabilities(): Promise<CapabilitySet>   // probe once, cache
  hasCapability(name: string): boolean

  // Lifecycle
  dispose(): void
}

interface ExecOptions {
  stdin?: string
  timeout?: number
  cancellationToken?: CancellationToken  // wired to VS Code cancellation
  env?: Record<string, string>           // LC_ALL=C, NO_COLOR=1
}

interface GovernorTransport {
  kind: 'cli' | 'rpc'
  execute(args: string[], opts: ExecOptions): Promise<RawResult>
}
```

### Why this matters now

1. **Cancellation tokens**: Correlator polling without cancellation = spawn storm
2. **Feature detection**: Probe `governor preflight --json` once → if it works, enable preflight UI; if not, hide it. No version string parsing
3. **Transport abstraction**: When remote governor lands (daemon RPC over forwarded socket or TCP), swap the transport without rewriting every caller
4. **Env discipline**: Force `LC_ALL=C`, `NO_COLOR=1` on all spawns so JSON is always JSON

---

## Remote Governor (design-for, not build-now)

The current extension assumes `governor` is a local binary. Future scenarios:

| Scenario | Transport | What changes |
|----------|-----------|-------------|
| VS Code Remote SSH/WSL | CLI on remote host | Binary path must be remote-aware (already works if PATH is right) |
| Shared daemon (team server) | RPC over TCP/forwarded socket | New `RpcTransport` behind `GovernorTransport` interface |
| Codespaces / devcontainer | CLI in container | Same as remote SSH |

### Design constraints for V7

- **Never hardcode `spawn`** — all execution goes through `GovernorClient.transport`
- **Settings**: `governor.executablePath` supports remote paths; add `governor.transport` setting (`"cli"` | `"rpc"`) and `governor.rpcEndpoint` (socket path or `host:port`) for future use
- **Feature detection** works identically over both transports (capabilities response is the same JSON)
- **Don't build RPC transport yet** — just don't preclude it

---

## Feature additions (V7.0 → V7.2)

### V7.0 — Foundation + Preflight + Correlator

**GovernorClient refactor** (prerequisite for everything)
- `GovernorClient` class with `execJson`, `execVoid`, cancellation, env
- Feature detection via probe: try command → cache result
- Replace all existing `run*` / `check*` / `fetch*` functions
- Add `--no-color` / `LC_ALL=C` to all spawns

**Preflight on workspace open**
- CLI: `governor preflight --agent claude --json`
- Trigger: `onStartupFinished` (respects Workspace Trust — skip for untrusted)
- Render: New "Preflight" section in Selfcheck tree view
- Notification: Only on FAIL/HARD (configurable, default on)
- Setting: `governor.preflight.enabled` (default `true`), `governor.preflight.agent` (default `"claude"`)

**Correlator status + capture alerts**
- CLI: `governor correlator status --json`
- Background poll: configurable interval (default 30s), `governor.correlator.pollIntervalMs`
- Status bar: `K: T/F/A/C` compact display (or icon-only if space is tight)
- Capture alert: If correlator reports SHEAR or CAPTURED for N consecutive polls (hysteresis, default 3), show persistent warning in Problems panel + status bar turns red
- Tree view: New "Correlator" section — K-vector dimensions, capture indicators, last transition time
- Kill switch: `governor.correlator.enabled` (default `true`)
- Spawn discipline: one-in-flight mutex, cancellation token on dispose

**Settings added in V7.0:**
| Setting | Default | Description |
|---------|---------|-------------|
| `governor.preflight.enabled` | `true` | Run preflight on workspace open |
| `governor.preflight.agent` | `"claude"` | Agent type for preflight |
| `governor.correlator.enabled` | `true` | Enable correlator polling |
| `governor.correlator.pollIntervalMs` | `30000` | Poll interval (ms) |
| `governor.backgroundActivity.enabled` | `true` | Master kill switch for ALL background activity |

### V7.1 — Scope + Capture UX

**Scope view**
- CLI: `governor scope status --json`, `governor scope check <tool> --axis file=<path>`
- Command: `Governor: Check Scope` — runs scope check against current editor file
- Tree view: New "Scope" section — grants, contracts, escalation history, effective authority level
- Status bar: scope authority level (optional, compact)
- Context menu: "Governor: Check Scope for This File" on editor right-click

**Capture alert UX (polish)**
- Capture state → persistent Problems panel entry (source: "governor correlator")
- Sticky banner in tree view (not just status bar)
- Require explicit dismissal or sustained OK (N polls) to clear
- Deep link: click capture alert → correlator tree view detail

**Scar history**
- CLI: `governor scar list --json`, `governor scar history --json`
- Tree view: New "Scars" section — active scars (hard/soft), shields, failure provenance
- Shows what actions are constrained and why

### V7.2 — Kernel Verify + Oracle Evidence

**Kernel verify**
- CLI: `governor kernel verify --run <id>`, `governor kernel runs --json`
- Tree view: "Kernel Runs" section — run list, click to expand invariant verdicts
- Detail view: Verdict ceiling, top blocking invariants, chain status (hash-chained OK / broken)
- Deep link from receipt → kernel run

**Oracle pytest evidence**
- CLI: `governor gate check --oracle pytest`
- Command: `Governor: Run Oracle Check` — runs pytest oracle against workspace
- Tree view: Oracle evidence status in "Evidence" section (STRONG/WEAK indicator)
- Integration: when oracle evidence exists, HARD claims show evidence attachment status

**Drift detection**
- CLI: `governor drift status --json`
- Tree view: "Drift" entry in Stability section — alert level, quarantined premises
- Problems panel: drift alert as warning when level is elevated

---

## Cross-cutting concerns (apply to all phases)

### Workspace Trust
- All background activity (preflight, correlator polling) disabled for untrusted workspaces
- Manual commands still work (user initiated = trusted)
- Follow VS Code Workspace Trust API

### Spawn discipline
- One-in-flight mutex per command type (no overlapping correlator polls)
- Cancellation tokens wired from VS Code disposables
- Configurable timeouts (default 30s, kernel verify gets 60s)
- Arg arrays only — no shell string construction (Windows safety)

### Parsing
- Ignore unknown JSON fields (forward-compatible)
- Non-JSON on stdout = parse error, logged to output channel
- stderr always logged (never parsed as data)

### UX escape hatches
- Every tree view node: "Copy Command" (the CLI command that produced this data)
- Every tree view node: "Copy JSON" (raw response)
- Receipt IDs / run IDs clickable → deep link to detail view

### Alert hysteresis
- Correlator capture, drift alerts, scope violations all require N consecutive samples before showing
- Once shown, require sustained OK or explicit dismiss to clear
- No blinking Christmas tree

---

## Acceptance criteria

| Feature | Criterion |
|---------|-----------|
| GovernorClient | All existing commands work through new client; cancellation token prevents zombie spawns |
| Preflight | Runs on workspace open (if enabled); result visible in Selfcheck within 2s |
| Correlator | K-vector updates on timer; capture state triggers persistent, dismissible alert |
| Scope | Check against current file returns rendered grant/deny breakdown |
| Kernel verify | Run detail shows invariant list + blockers without opening terminal |
| Oracle | Evidence status visible and matches CLI output |
| Feature detection | Unknown commands gracefully hidden (no error popups) |
| Remote-ready | No `spawn` calls outside `GovernorTransport`; settings exist for future RPC transport |

---

## Sequencing

```
V7.0 (foundation)
├── GovernorClient refactor
├── Feature detection (probe + cache)
├── Preflight on open
└── Correlator polling + status bar K-vector

V7.1 (scope + capture UX)
├── Scope view + scope check command
├── Capture alert UX (Problems panel + hysteresis)
└── Scar history view

V7.2 (kernel + oracle)
├── Kernel verify view
├── Oracle evidence integration
└── Drift detection status
```

Each phase ships something usable. V7.0 is the must-have before anything else — the GovernorClient refactor is load-bearing for all subsequent work.

---

## What this plan does NOT cover

- **Daemon RPC transport**: Designed for, not built. Swap `CliTransport` → `RpcTransport` when remote governor is real.
- **Fiction/Nonfiction modes**: CLI supports them; extension passes `--mode` but has no mode-specific UI.
- **Multi-agent dispatcher**: Quorum, agent registration, task claims — team-scale features, not IDE features (yet).
- **Telemetry dashboard**: Cost/performance analysis belongs in WebUI, not the editor sidebar.
