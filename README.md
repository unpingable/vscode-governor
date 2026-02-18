# Governor for VS Code

**IDE frontend for [Agent Governor](https://github.com/unpingable/agent_governor).**
Diagnostics, state inspection, receipts, and guard-rail signals surfaced where you write code.

This extension does **not** re-implement governance logic. It shells out to the local `governor` CLI and renders the results.

---

## Compatibility

| Feature | Minimum Governor CLI |
|---------|---------------------|
| Core (diagnostics, state, intent, receipts) | >= 2.0.0 |
| Preflight on open | >= 2.1.0 |
| Correlator / capture alerts | >= 2.1.0 |
| Scope view, scar history | >= 2.1.0 |
| Doctor diagnostics (Problems panel) | >= 2.2.0 |
| Lane routing, operator dashboard | >= 2.3.0 |

Features are **capability-probed** and degrade gracefully. If a subcommand doesn't exist on your CLI version, the corresponding UI simply won't appear.

**Version convention:** Extension version tracks Governor's major/minor baseline. Extension `2.3.x` targets Governor `2.3.x`. Patch versions drift independently. See `COMPAT.md` for contract version details.

---

## What you get

### Doctor Diagnostics (Problems panel)
`governor doctor --json` results mapped to VS Code Problems panel. Non-ok subsystem checks appear as warnings/errors. Click "More info" to open the full doctor report.

Polls every 60s (configurable). Overlap guard prevents stacking. Churn detection avoids UI flicker when nothing changed.

### Security + Continuity Diagnostics
Security + continuity findings inline via `governor check`. Squiggles, severity icons, suggestions.

### Correlator Status Bar + Capture Alerts
K-vector (T/F/A/C) in the status bar. Capture detection with hysteresis — persistent Problems panel entry after N consecutive captured polls.

### State TreeView (sidebar)
Structured view of governor state via `governor state --json --schema v2`:

| Section | What it shows |
|---------|--------------|
| **Problems** | Active violations, severity-coded |
| **Intent** | Current profile, scope, deny, timebox, active overrides |
| **Compare** | Interferometry: risk markers, anchor conflicts, tier |
| **Decisions** | Topic + choice + rationale |
| **Claims** | Status (proposed/stabilized/stale/contradicted), confidence % |
| **Evidence** | Types, sources, linked claims |
| **Receipts** | Gate receipts: verdict, gate, timestamp |
| **Session** | Mode, authority level, jurisdiction, constraints |
| **Regime** | ELASTIC/WARM/DUCTILE/UNSTABLE, boil mode |
| **Stability** | Rejection rate, claim churn, contradiction density, drift alert |
| **Scope** | Run scope, grants, contracts, escalation count |
| **Scars** | Active scars (hard/soft), shields, failure provenance |

### Code Actions (quick fixes)
- Apply suggestion
- Mark as reviewed (`// @security-reviewed: SEC001`)
- Allow here (`// governor-allow: CODE`)
- Ignore file (`// governor-disable-file CODE`)

### Hover Tooltips
Hover over code to see relevant decisions, claims, and violations in context.

### Real-Time Checking
Optional debounced on-type checking (off by default). Skips large files, excluded languages, non-file URIs.

### Status Bar
- Governor health: pass/warn/error icon + current profile
- Selfcheck: OK or failure/warning count with item details on hover
- Correlator: K-vector compact display, capture alert

---

## Requirements

- [Agent Governor](https://github.com/unpingable/agent_governor) installed and on PATH
- A `.governor/` directory in your workspace (run `governor init`)

Quick sanity:

```bash
governor selfcheck
governor doctor --json
governor state --json --schema v2 | head
```

If those fail, the extension will fail in more creative ways.

---

## Installation

### From GitHub Releases (.vsix)

Download the `.vsix` from [Releases](https://github.com/unpingable/vscode-governor/releases), then:

```
VS Code → Extensions → ⋯ → Install from VSIX...
```

### From source

```bash
git clone https://github.com/unpingable/vscode-governor.git
cd vscode-governor
npm ci
npm run build
npx @vscode/vsce package    # produces .vsix
# VS Code → Extensions → Install from VSIX
```

---

## Commands

| Command | Binding | What it does |
|---------|---------|-------------|
| `Governor: Check File` | Ctrl+Shift+G | Run `governor check` on active file |
| `Governor: Check Selection` | — | Check selected text via stdin |
| `Governor: Check Current File Now` | — | Force immediate check |
| `Governor: Toggle Real-time Checking` | Ctrl+Shift+Alt+G | Enable/disable on-type checking |
| `Governor: Run Doctor Checks` | — | Run `governor doctor`, update Problems panel |
| `Governor: Set Profile` | — | Switch intent profile (greenfield/established/production/hotfix/refactor) |
| `Governor: Clear Intent` | — | Remove current profile |
| `Governor: Show Intent` | — | Display intent + provenance in output |
| `Governor: Compare with Other Models` | — | Show last interferometry comparison |
| `Governor: Show Self-Check Details` | — | Full selfcheck report |
| `Governor: Show Correlator Status` | — | K-vector + capture indicator details |
| `Governor: Show Scope Status and Grants` | — | Scope axes, contracts, grants |
| `Governor: Show Scar Status` | — | Scars, shields, health |
| `Governor: Show Receipt Detail` | — | Receipt + evidence bundle |
| `Governor: Run Preflight Checks` | — | Explicit preflight run |
| `Governor: Refresh State` | — | Reload all state views |
| `Governor: Show Output` | — | Open governor output channel |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `governor.executablePath` | `"governor"` | Path to governor CLI (absolute recommended for Remote SSH/WSL) |
| `governor.checkOnSave` | `false` | Auto-check on save |
| `governor.mode` | `"auto"` | Operating mode (auto/code/fiction/nonfiction) |
| `governor.realtimeChecking.enabled` | `false` | Check as you type |
| `governor.realtimeChecking.debounceMs` | `500` | Debounce delay (ms) |
| `governor.realtimeChecking.excludedLanguages` | `["json","yaml","markdown","plaintext"]` | Skip these languages |
| `governor.hover.enabled` | `true` | Show context on hover |
| `governor.codeActions.enabled` | `true` | Quick fix suggestions |
| `governor.interferometry.autoCompare` | `false` | Auto-run compare after interferometry |
| `governor.backgroundActivity.enabled` | `true` | Master kill switch for all background activity |
| `governor.preflight.enabled` | `true` | Run preflight on workspace open |
| `governor.preflight.agent` | `"claude"` | Agent type for preflight |
| `governor.correlator.enabled` | `true` | Enable correlator polling |
| `governor.correlator.pollIntervalMs` | `30000` | Correlator poll interval (ms) |
| `governor.correlator.captureThreshold` | `3` | Consecutive captured polls before alert |
| `governor.correlator.clearThreshold` | `3` | Consecutive OK polls to clear alert |
| `governor.doctor.enabled` | `true` | Enable doctor polling and Problems diagnostics |
| `governor.doctor.pollIntervalMs` | `60000` | Doctor poll interval (ms) |

---

## Architecture

```
Governor CLI
    |
JSON stdout
    |
client.ts (GovernorClient: spawn + JSON.parse + capability probe)
    |
types.ts (CheckResult | GovernorViewModelV2 | DoctorResult | CorrelatorStatus | ...)
    |
Extension  ->  DiagnosticProvider     ->  Problems panel (file checks)
           ->  DoctorContentProvider  ->  Problems panel (subsystem health)
           ->  CaptureAlertProvider   ->  Problems panel (correlator capture)
           ->  TreeProvider           ->  Sidebar TreeView
           ->  HoverProvider          ->  Hover tooltips
           ->  CodeActionProvider     ->  Quick fixes
           ->  RealtimeChecker        ->  Background checking
```

The extension is a **non-authoritative client**. It renders what the CLI reports. It cannot override policy, mint receipts, or broaden scope.

---

## CLI commands used

Every UI surface maps to a CLI command. When the UI lies, re-ground in the terminal.

| Surface | CLI command |
|---------|------------|
| Diagnostics | `governor check <path> --format json` |
| Diagnostics (selection) | `governor check --stdin --format json` |
| Doctor | `governor doctor --json` |
| State TreeView | `governor state --json --schema v2` |
| Intent | `governor intent show --json` / `intent set` / `intent clear` |
| Overrides | `governor override list --json` |
| Compare | `governor interferometry compare --last --json` |
| Selfcheck | `governor selfcheck --json [--full]` |
| Correlator | `governor correlator status --json` |
| Scope | `governor scope status --json` / `scope grants --json` |
| Scars | `governor scar list --json` / `scar history --json` |
| Preflight | `governor preflight --agent claude --json` |
| Receipts | `governor receipts --json [--gate X --verdict Y --last N]` |
| Receipt detail | `governor receipts --id <id> --evidence --json` |

---

## Troubleshooting

### "Command not found" / nothing happens
- Confirm VS Code can see your PATH (GUI shells often can't)
- Set an explicit absolute path in `governor.executablePath`
- VS Code Remote (SSH/WSL/Containers): `governor` must exist on the **remote host**, not your local machine

### JSON parse failures
- Run the mapped CLI command manually in a terminal
- Enable verbose logging via the Governor output channel
- Check stderr — non-JSON on stdout is a bug in governor, not the extension

### Doctor shows nothing / "not available"
- Check the Governor output channel for "Doctor diagnostics not available"
- Upgrade governor CLI to >= 2.2.0
- Features are capability-probed: if `governor doctor --help` fails, doctor UI is silently disabled

### Extension feels stale vs CLI behavior
- The extension is a renderer. If CLI JSON schema changes, the extension must update
- Run `Governor: Refresh State` to force a re-fetch

---

## Development

```bash
npm ci
npm run build       # Build with esbuild
npm run watch       # Watch mode
npm run lint        # TypeScript type check
npm run test        # Run tests (176 tests)
npx @vscode/vsce package   # Package as .vsix
```

---

## What this extension is not

- Not the governor kernel (that's [agent_governor](https://github.com/unpingable/agent_governor))
- Not the web cockpit (that's [gov-webui](https://github.com/unpingable/governor_webui))
- Not a linter — it's a governance dashboard that happens to produce diagnostics

---

## License

Apache-2.0
