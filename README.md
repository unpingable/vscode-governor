# Governor for VS Code

**IDE frontend for [Agent Governor](https://github.com/unpingable/agent_governor).**
Diagnostics, state inspection, receipts, and guard-rail signals surfaced where you write code.

This extension does **not** re-implement governance logic. It shells out to the local `governor` CLI and renders the results.

---

## What you get

### Diagnostics (Problems panel)
Security + continuity findings inline via `governor check`. Squiggles, severity icons, suggestions.

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

---

## Requirements

- [Agent Governor](https://github.com/unpingable/agent_governor) installed and on PATH
- A `.governor/` directory in your workspace (run `governor init`)

Quick sanity:

```bash
governor selfcheck
governor state --json --schema v2 | head
```

If those fail, the extension will fail in more creative ways.

---

## Installation

```bash
git clone https://github.com/unpingable/vscode-governor.git
cd vscode-governor
npm ci
npm run build
npm run package    # produces .vsix
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
| `Governor: Set Profile` | — | Switch intent profile (greenfield/established/production/hotfix/refactor) |
| `Governor: Clear Intent` | — | Remove current profile |
| `Governor: Show Intent` | — | Display intent + provenance in output |
| `Governor: Compare with Other Models` | — | Show last interferometry comparison |
| `Governor: Show Self-Check Details` | — | Full selfcheck report |
| `Governor: Show Receipt Detail` | — | Receipt + evidence bundle |
| `Governor: Refresh State` | — | Reload all state views |
| `Governor: Show Output` | — | Open governor output channel |
| `Governor: Show Detail` | — | Dump JSON to output channel |

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

---

## Architecture

```
Governor CLI
    ↓
JSON stdout
    ↓
client.ts (spawn + JSON.parse)
    ↓
types.ts (CheckResult | GovernorViewModelV2)
    ↓
Extension  →  DiagnosticProvider  →  Problems panel
           →  TreeProvider         →  Sidebar TreeView
           →  HoverProvider        →  Hover tooltips
           →  CodeActionProvider   →  Quick fixes
           →  RealtimeChecker      →  Background checking
```

The extension is a **non-authoritative client**. It renders what the CLI reports. It cannot override policy, mint receipts, or broaden scope.

---

## CLI commands used

Every UI surface maps to a CLI command. When the UI lies, re-ground in the terminal.

| Surface | CLI command |
|---------|------------|
| Diagnostics | `governor check <path> --format json` |
| Diagnostics (selection) | `governor check --stdin --format json` |
| State TreeView | `governor state --json --schema v2` |
| Intent | `governor intent show --json` / `intent set` / `intent clear` |
| Overrides | `governor override list --json` |
| Compare | `governor interferometry compare --last --json` |
| Selfcheck | `governor selfcheck --json [--full]` |
| Receipts | `governor receipts --json [--gate X --verdict Y --last N]` |
| Receipt detail | `governor receipts --id <id> --evidence --json` |

---

## What's not wired yet

The governor CLI has shipped major subsystems since this extension was last updated. These exist in the CLI but don't have extension UI yet:

| Feature | CLI | Gap |
|---------|-----|-----|
| **Preflight** | `governor preflight --agent claude --json` | No run-on-open, no panel |
| **Scope Governor** | `governor scope check <tool> --axis file=<path>` | No scope view, no file-level gating |
| **Correlator / Capture Detection** | `governor correlator status --json` | No K-vector status bar, no capture alerts |
| **Receipt Kernel** | `governor kernel verify --run <id>` | No invariant verdict view |
| **Oracle Evidence** | `governor gate check --oracle pytest` | No oracle status display |
| **Scar History** | `governor scar history` | No constraint learning view |
| **Drift Detection** | `governor drift status` | No drift alert integration |

See [V7 Plan](V7_PLAN.md) for the roadmap to close these gaps.

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
npm run test        # Run tests
npm run package     # Package as .vsix
```

---

## What this extension is not

- Not the governor kernel (that's [agent_governor](https://github.com/unpingable/agent_governor))
- Not the web cockpit (that's [gov-webui](https://github.com/unpingable/governor_webui))
- Not a linter — it's a governance dashboard that happens to produce diagnostics

---

## License

Apache-2.0
