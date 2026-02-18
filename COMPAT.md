# Compatibility

This repo is the VS Code extension for Agent Governor.

## Version coupling

Tracks Governor **major.minor**. Client 2.3.x expects governor 2.3.x.
Patch versions are independent.

## Compatible Governor versions

- Required: `>=2.3.0 <2.4.0`

## Contract versions (wire / JSON)

| Contract | Version | Used For |
|----------|---------|----------|
| RPC protocol | 1.0 | `governor.hello` handshake (daemon stdio/socket) |
| StatusRollup schema | 1 | `governor status --json` operator dashboard |
| ViewModel schema | v2 | `governor state --json --schema v2` |
| Receipt schema | 2 | Gate receipt `from_dict()` |

## Feature negotiation

The extension probes `governor doctor --json` on activation. If the CLI is
unavailable or returns exit code >= 2, features degrade:

- Doctor diagnostics: disabled (one-time log)
- Correlator K-vector: status bar hidden
- Scope/scar views: empty tree
- Preflight-on-open: skipped

The extension never scrapes human text output. All data comes from `--json` surfaces.
