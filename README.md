# VS Code Governor

VS Code extension for [Agent Governor](https://github.com/unpingable/agent_governor) — security and continuity checking for agentic coding tools.

**Version:** 0.4.0 (CLI-based integration, compatible with Governor v2.x)

## What It Does

- Real-time security + continuity checking via `governor check`
- Governor state TreeView in the activity bar (regime, decisions, claims, violations)
- Code actions and hover tooltips for findings
- Intent profile management (`governor intent set`)
- Multi-model code comparison (`governor interferometry compare`)

## Requirements

- [Agent Governor](https://github.com/unpingable/agent_governor) installed and on PATH
- A `.governor/` directory in your workspace (run `governor init`)

## Installation

```bash
# From source
git clone https://github.com/unpingable/vscode-governor.git
cd vscode-governor
npm ci
npm run build
# Then: VS Code → Extensions → Install from VSIX
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `governor.executablePath` | `"governor"` | Path to governor CLI |
| `governor.checkOnSave` | `false` | Auto-check on save |
| `governor.mode` | `"auto"` | Operating mode (auto/code/fiction/nonfiction) |
| `governor.realtimeChecking.enabled` | `false` | Check as you type |
| `governor.realtimeChecking.debounceMs` | `500` | Debounce delay (ms) |
| `governor.hover.enabled` | `true` | Show context on hover |
| `governor.codeActions.enabled` | `true` | Quick fix suggestions |

## Commands

- `Governor: Check File` (Ctrl+Shift+G)
- `Governor: Check Selection`
- `Governor: Toggle Real-time Checking`
- `Governor: Set Profile`
- `Governor: Compare with Other Models`
- `Governor: Refresh State`
- `Governor: Show Intent`

## Architecture

This extension integrates via the `governor` CLI (not the daemon RPC protocol). It shells out to `governor check --format json` and `governor state --json` and renders the results as diagnostics, TreeView nodes, and hover content.

### Current Status

- CLI-based integration: stable, tested with Governor v2.0.0
- Does not yet surface v2 features (gate receipts, selfcheck, daemon health)
- Planned: daemon RPC integration for v3 (when Governor moves to service mode)

## Development

```bash
npm ci
npm run build       # Build with esbuild
npm run watch       # Watch mode
npm run lint        # TypeScript type check
npm run test        # Run tests
npm run package     # Package as .vsix
```

## License

MIT
