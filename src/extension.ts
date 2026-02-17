// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Governor VS Code Extension — entry point.
 *
 * V7.0: GovernorClient class, preflight on open, correlator polling.
 */

import * as vscode from "vscode";
import { GovernorClient, SetIntentOptions } from "./governor/client";
import type { CheckResult, GovernorViewModelV2, IntentResult, SelfcheckResult, CorrelatorStatus } from "./governor/types";
import { CaptureAlertProvider, setCaptureAlert, clearCaptureAlert } from "./capture-alert";
import { DiagnosticProvider } from "./diagnostics/provider";
import { GovernorTreeProvider } from "./views/governorTree";
import { GovernorHoverProvider } from "./hovers/provider";
import { GovernorCodeActionProvider, updateFindings, clearFindings } from "./code-actions/provider";
import { RealtimeChecker } from "./realtime/checker";

let outputChannel: vscode.OutputChannel;
let diagnosticProvider: DiagnosticProvider;
let statusBarItem: vscode.StatusBarItem;
let realtimeChecker: RealtimeChecker | null = null;
let hoverProvider: GovernorHoverProvider | null = null;
let selfcheckStatusBar: vscode.StatusBarItem;
let correlatorStatusBar: vscode.StatusBarItem;
let currentIntent: IntentResult | null = null;
let treeProviderRef: GovernorTreeProvider | null = null;
let client: GovernorClient;
let correlatorTimer: ReturnType<typeof setInterval> | null = null;
let lastCorrelatorStatus: CorrelatorStatus | null = null;
let capturedConsecutive = 0;
let okConsecutive = 0;
let captureAlertProvider: CaptureAlertProvider;
let correlatorDiagnostics: vscode.DiagnosticCollection;

function getClientConfig() {
  const config = vscode.workspace.getConfiguration("governor");
  const executablePath = config.get<string>("executablePath", "governor");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return { executablePath, cwd };
}

function updateStatusBar(result: CheckResult): void {
  const icon =
    result.status === "pass" ? "$(shield)"
    : result.status === "warn" ? "$(warning)"
    : "$(error)";
  const label =
    result.status === "pass" ? "Pass"
    : result.status === "warn" ? "Warn"
    : "Error";

  const profile = currentIntent?.intent.profile;
  const profileText = profile && profile !== "established" ? ` [${profile}]` : "";

  statusBarItem.text = `${icon} Governor${profileText}: ${label}`;
  statusBarItem.tooltip = result.summary + (profile ? `\nProfile: ${profile}` : "");
  statusBarItem.show();
}

async function refreshIntent(): Promise<void> {
  try {
    currentIntent = await client.getIntent();
  } catch {
    currentIntent = null;
  }
}

function updateSelfcheckStatusBar(result: SelfcheckResult | null): void {
  if (!result) {
    selfcheckStatusBar.text = "$(question) Selfcheck: ?";
    selfcheckStatusBar.tooltip = "Selfcheck unavailable";
    selfcheckStatusBar.backgroundColor = undefined;
    selfcheckStatusBar.show();
    return;
  }

  if (result.overall === "ok") {
    selfcheckStatusBar.text = "$(verified) Selfcheck: OK";
    selfcheckStatusBar.tooltip = result.items.map((i) => `${i.name}: ${i.status}`).join("\n");
    selfcheckStatusBar.backgroundColor = undefined;
  } else {
    const failCount = result.items.filter((i) => i.status === "fail").length;
    const warnCount = result.items.filter((i) => i.status === "warn").length;
    selfcheckStatusBar.text = `$(warning) Selfcheck: ${failCount}F/${warnCount}W`;
    selfcheckStatusBar.tooltip = result.items
      .filter((i) => i.status !== "ok")
      .map((i) => `[${i.status.toUpperCase()}] ${i.name}: ${i.detail}`)
      .join("\n");
    selfcheckStatusBar.backgroundColor = failCount > 0
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  selfcheckStatusBar.show();
}

async function runSelfcheckRefresh(): Promise<void> {
  try {
    const result = await client.runSelfcheck();
    updateSelfcheckStatusBar(result);
  } catch {
    updateSelfcheckStatusBar(null);
  }
}

// =========================================================================
// V7.0: Correlator status bar
// =========================================================================

function updateCorrelatorStatusBar(status: CorrelatorStatus | null, isError = false): void {
  if (!status) {
    correlatorStatusBar.hide();
    // Errors don't count as "OK" toward clearThreshold
    if (!isError) {
      okConsecutive++;
      capturedConsecutive = 0;
    }
    return;
  }

  const k = status.kvector;
  const compact = `T:${k.throughput.toFixed(1)} F:${k.fidelity.toFixed(1)} A:${k.authority.toFixed(1)} C:${k.cost.toFixed(1)}`;

  if (status.is_captured) {
    capturedConsecutive++;
    okConsecutive = 0;
  } else {
    capturedConsecutive = 0;
    okConsecutive++;
  }

  // Read thresholds dynamically (no restart needed)
  const config = vscode.workspace.getConfiguration("governor");
  const captureThreshold = Math.max(1, Math.min(10, config.get<number>("correlator.captureThreshold", 3)));
  const clearThreshold = Math.max(1, Math.min(10, config.get<number>("correlator.clearThreshold", 3)));

  const showCapture = capturedConsecutive >= captureThreshold;

  if (showCapture) {
    correlatorStatusBar.text = `$(alert) CAPTURED K:[${compact}]`;
    correlatorStatusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    correlatorStatusBar.tooltip = `Capture detected!\n${status.capture_indicators
      .filter((i) => i.active)
      .map((i) => `${i.name}: ${i.consecutive_windows}/${i.threshold} windows`)
      .join("\n")}\n\nK-vector: ${compact}`;

    // V7.1: Set capture alert in Problems panel
    captureAlertProvider.updateStatus(status);
    setCaptureAlert(correlatorDiagnostics, status);
  } else {
    correlatorStatusBar.text = `$(pulse) K:[${compact}]`;
    correlatorStatusBar.backgroundColor = undefined;
    correlatorStatusBar.tooltip = `Correlator: ${status.regime}\n\nK-vector:\n  Throughput: ${k.throughput}\n  Fidelity: ${k.fidelity}\n  Authority: ${k.authority}\n  Cost: ${k.cost}`;

    // V7.1: Clear capture alert after enough consecutive OK polls
    if (okConsecutive >= clearThreshold) {
      clearCaptureAlert(correlatorDiagnostics);
    }
  }
  correlatorStatusBar.show();

  lastCorrelatorStatus = status;
}

async function pollCorrelator(): Promise<void> {
  try {
    const status = await client.getCorrelatorStatus();
    updateCorrelatorStatusBar(status);
  } catch {
    // Silently hide on failure — errors don't count as "OK"
    updateCorrelatorStatusBar(null, /* isError */ true);
  }
}

function startCorrelatorPolling(): void {
  const config = vscode.workspace.getConfiguration("governor");
  if (!config.get<boolean>("backgroundActivity.enabled", true)) { return; }
  if (!config.get<boolean>("correlator.enabled", true)) { return; }

  const interval = config.get<number>("correlator.pollIntervalMs", 30_000);
  stopCorrelatorPolling();

  // Initial poll
  pollCorrelator();

  correlatorTimer = setInterval(() => { pollCorrelator(); }, interval);
}

function stopCorrelatorPolling(): void {
  if (correlatorTimer) {
    clearInterval(correlatorTimer);
    correlatorTimer = null;
  }
}

// =========================================================================
// V7.0: Preflight on workspace open
// =========================================================================

async function runPreflightOnOpen(): Promise<void> {
  const config = vscode.workspace.getConfiguration("governor");

  // Respect master kill switch
  if (!config.get<boolean>("backgroundActivity.enabled", true)) { return; }
  if (!config.get<boolean>("preflight.enabled", true)) { return; }

  // Respect Workspace Trust
  if (!vscode.workspace.isTrusted) { return; }

  const caps = await client.getCapabilities();
  if (!caps.preflight) { return; }

  const agent = config.get<string>("preflight.agent", "claude");

  try {
    const result = await client.runPreflight(agent);
    outputChannel.appendLine(`\n=== Preflight (${agent}) ===`);
    for (const check of result.checks) {
      outputChannel.appendLine(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
    }
    outputChannel.appendLine(`Overall: ${result.overall}`);

    if (result.overall === "fail") {
      const failedChecks = result.checks.filter((c) => c.status === "fail");
      const msg = `Preflight: ${failedChecks.length} check(s) failed — ${failedChecks.map((c) => c.name).join(", ")}`;
      vscode.window.showWarningMessage(msg, "Show Details").then((action) => {
        if (action === "Show Details") { outputChannel.show(); }
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`Preflight error: ${msg}`);
  }
}

// =========================================================================
// Core commands
// =========================================================================

async function runCheckFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const filePath = editor.document.uri.fsPath;
  outputChannel.appendLine(`Checking file: ${filePath}`);

  try {
    const result = await client.checkFile(filePath);
    diagnosticProvider.update(editor.document.uri, result);
    updateFindings(editor.document.uri, result.findings);
    updateStatusBar(result);
    outputChannel.appendLine(`Result: ${result.summary}`);
    for (const f of result.findings) {
      outputChannel.appendLine(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`Error: ${msg}`);
    vscode.window.showErrorMessage(`Governor check failed: ${msg}`);
    statusBarItem.text = "$(error) Governor: Failed";
    statusBarItem.show();
  }
}

async function runCheckSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showWarningMessage("No text selected.");
    return;
  }

  const content = editor.document.getText(selection);
  const filePath = editor.document.uri.fsPath;
  const selectionStartLine = selection.start.line;

  outputChannel.appendLine(`Checking selection in ${filePath} (line ${selectionStartLine + 1})`);

  try {
    const result = await client.checkStdin({ content, filepath: filePath });

    for (const f of result.findings) {
      f.range.start.line += selectionStartLine;
      f.range.end.line += selectionStartLine;
    }

    diagnosticProvider.update(editor.document.uri, result);
    updateFindings(editor.document.uri, result.findings);
    updateStatusBar(result);
    outputChannel.appendLine(`Result: ${result.summary}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`Error: ${msg}`);
    vscode.window.showErrorMessage(`Governor check failed: ${msg}`);
  }
}

async function checkContentViaStdin(content: string, filepath: string): Promise<CheckResult> {
  return client.checkStdin({ content, filepath });
}

async function fetchStateWrapper(): Promise<GovernorViewModelV2> {
  return client.fetchState();
}

// =========================================================================
// Activation
// =========================================================================

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Governor");

  // Create client
  client = new GovernorClient(getClientConfig());
  diagnosticProvider = new DiagnosticProvider();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "governor.showOutput";
  statusBarItem.text = "$(shield) Governor";
  statusBarItem.tooltip = "Agent Governor";
  statusBarItem.show();

  selfcheckStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  selfcheckStatusBar.command = "governor.showSelfcheck";
  selfcheckStatusBar.text = "$(question) Selfcheck: ?";
  selfcheckStatusBar.tooltip = "Governor Selfcheck";
  selfcheckStatusBar.show();

  // V7.0: Correlator status bar
  correlatorStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  correlatorStatusBar.command = "governor.showCorrelator";
  correlatorStatusBar.text = "$(pulse) K: ?";
  correlatorStatusBar.tooltip = "Governor Correlator";

  // V7.1: Capture alert — virtual doc provider + diagnostics
  captureAlertProvider = new CaptureAlertProvider();
  correlatorDiagnostics = vscode.languages.createDiagnosticCollection("governor-correlator");

  // Tree view
  const getOptions = () => getClientConfig();
  const treeProvider = new GovernorTreeProvider(outputChannel, getOptions);
  treeProviderRef = treeProvider;
  const treeView = vscode.window.createTreeView("governorState", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // Hover provider
  hoverProvider = new GovernorHoverProvider(fetchStateWrapper, outputChannel);
  const hoverRegistration = vscode.languages.registerHoverProvider(
    { scheme: "file" },
    hoverProvider,
  );

  // Code action provider
  const codeActionProvider = new GovernorCodeActionProvider();
  const codeActionRegistration = vscode.languages.registerCodeActionsProvider(
    { scheme: "file" },
    codeActionProvider,
    { providedCodeActionKinds: GovernorCodeActionProvider.providedCodeActionKinds },
  );

  // Real-time checker
  realtimeChecker = new RealtimeChecker({
    checkFunction: checkContentViaStdin,
    onResult: (uri, result) => {
      diagnosticProvider.update(uri, result);
      updateStatusBar(result);
      hoverProvider?.invalidateCache();
    },
    outputChannel,
  });

  context.subscriptions.push(
    outputChannel,
    diagnosticProvider,
    statusBarItem,
    selfcheckStatusBar,
    correlatorStatusBar,
    correlatorDiagnostics,
    captureAlertProvider,
    vscode.workspace.registerTextDocumentContentProvider("agent-governor", captureAlertProvider),
    treeView,
    treeProvider,
    hoverProvider,
    hoverRegistration,
    codeActionRegistration,
    realtimeChecker,
    vscode.commands.registerCommand("governor.checkFile", runCheckFile),
    vscode.commands.registerCommand("governor.checkSelection", runCheckSelection),
    vscode.commands.registerCommand("governor.showOutput", () => { outputChannel.show(); }),
    vscode.commands.registerCommand("governor.refreshState", () => {
      treeProvider.refresh();
      hoverProvider?.invalidateCache();
      pollCorrelator();
    }),
    vscode.commands.registerCommand("governor.showDetail", (detail: string) => {
      outputChannel.appendLine(detail);
      outputChannel.show();
    }),
    vscode.commands.registerCommand("governor.toggleRealtime", () => {
      if (realtimeChecker) {
        const newState = !realtimeChecker.isEnabled();
        realtimeChecker.setEnabled(newState);
        vscode.window.showInformationMessage(
          `Governor: Real-time checking ${newState ? "enabled" : "disabled"}`,
        );
      }
    }),
    vscode.commands.registerCommand("governor.checkNow", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }
      if (realtimeChecker) {
        await realtimeChecker.checkNow(editor.document);
        vscode.window.showInformationMessage("Governor: Check complete");
      }
    }),
    // Code Autopilot: Profile switching
    vscode.commands.registerCommand("governor.setProfile", async () => {
      const profiles = [
        { label: "greenfield", description: "New project, experimenting (warn only)" },
        { label: "established", description: "Normal development (default)" },
        { label: "production", description: "High-stakes changes (strict)" },
        { label: "hotfix", description: "Urgent targeted fix (narrow scope)" },
        { label: "refactor", description: "Restructuring code (soft anchors)" },
      ];

      const selected = await vscode.window.showQuickPick(profiles, {
        placeHolder: "Select a profile",
        title: "Governor: Set Profile",
      });
      if (!selected) { return; }

      let scope: string[] | undefined;
      if (selected.label === "hotfix") {
        const scopeInput = await vscode.window.showInputBox({
          prompt: "Enter scope pattern (e.g., src/auth/**)",
          placeHolder: "src/**",
        });
        if (scopeInput) { scope = [scopeInput]; }
      }

      const reason = await vscode.window.showInputBox({
        prompt: "Why are you setting this profile? (optional)",
        placeHolder: "fixing auth bug",
      });

      try {
        const intentOpts: SetIntentOptions = {
          profile: selected.label,
          scope,
          reason: reason || undefined,
        };
        await client.setIntent(intentOpts);
        await refreshIntent();
        treeProvider.refresh();
        vscode.window.showInformationMessage(`Governor: Profile set to ${selected.label}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to set profile: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("governor.clearIntent", async () => {
      try {
        await client.clearIntent();
        currentIntent = null;
        treeProvider.refresh();
        vscode.window.showInformationMessage("Governor: Intent cleared");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clear intent: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("governor.showIntent", async () => {
      try {
        const intent = await client.getIntent();
        outputChannel.appendLine("\n=== Current Intent ===");
        outputChannel.appendLine(JSON.stringify(intent.intent, null, 2));
        outputChannel.appendLine("\n=== Provenance ===");
        for (const p of intent.provenance) {
          outputChannel.appendLine(`[${p.layer}] ${p.reason || ""}`);
        }
        outputChannel.show();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Error fetching intent: ${msg}`);
        outputChannel.show();
      }
    }),
    vscode.commands.registerCommand("governor.compareModels", async () => {
      try {
        outputChannel.appendLine("Running code compare...");
        const report = await client.runCodeCompare();
        outputChannel.appendLine(JSON.stringify(report, null, 2));

        if (report.tier >= 1) {
          const markerCount = (report.risk_marker_union || []).length;
          const conflictCount = (report.anchor_conflicts || []).length;
          const parts: string[] = [];
          if (markerCount) { parts.push(`${markerCount} risk marker(s)`); }
          if (conflictCount) { parts.push(`${conflictCount} anchor conflict(s)`); }
          vscode.window.showWarningMessage(
            `Models disagreed. ${parts.join(", ")}. [View Details]`,
            "View Details", "Dismiss",
          ).then((action) => {
            if (action === "View Details") { outputChannel.show(); }
          });
        } else {
          vscode.window.showInformationMessage("Governor: No divergence detected.");
        }

        treeProvider.refresh();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Compare error: ${msg}`);
        vscode.window.showErrorMessage(`Governor compare failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("governor.showSelfcheck", async () => {
      try {
        const result = await client.runSelfcheck(true);
        outputChannel.appendLine("\n=== Selfcheck (Full) ===");
        for (const item of result.items) {
          outputChannel.appendLine(`[${item.status.toUpperCase()}] ${item.name}: ${item.detail}`);
        }
        outputChannel.appendLine(`Overall: ${result.overall}`);
        outputChannel.show();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Selfcheck error: ${msg}`);
        outputChannel.show();
      }
    }),
    vscode.commands.registerCommand("governor.showReceiptDetail", async (receiptId: string) => {
      try {
        const receipt = await client.getReceiptDetail(receiptId, true);
        outputChannel.appendLine("\n=== Receipt Detail ===");
        outputChannel.appendLine(JSON.stringify(receipt, null, 2));
        outputChannel.show();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Receipt detail error: ${msg}`);
        outputChannel.show();
      }
    }),
    // V7.0: Show correlator details
    vscode.commands.registerCommand("governor.showCorrelator", async () => {
      try {
        const status = await client.getCorrelatorStatus();
        outputChannel.appendLine("\n=== Correlator Status ===");
        outputChannel.appendLine(`Regime: ${status.regime}`);
        outputChannel.appendLine(`Captured: ${status.is_captured}`);
        outputChannel.appendLine(`\nK-Vector:`);
        outputChannel.appendLine(`  Throughput: ${status.kvector.throughput}`);
        outputChannel.appendLine(`  Fidelity:   ${status.kvector.fidelity}`);
        outputChannel.appendLine(`  Authority:  ${status.kvector.authority}`);
        outputChannel.appendLine(`  Cost:       ${status.kvector.cost}`);
        outputChannel.appendLine(`\nCapture Indicators:`);
        for (const ind of status.capture_indicators) {
          const marker = ind.active ? "[ACTIVE]" : "[      ]";
          outputChannel.appendLine(`  ${marker} ${ind.name}: ${ind.consecutive_windows}/${ind.threshold} windows`);
        }
        outputChannel.show();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Correlator error: ${msg}`);
        outputChannel.show();
      }
    }),
    // V7.1: Show scope status
    vscode.commands.registerCommand("governor.showScope", async () => {
      try {
        const status = await client.getScopeStatus();
        const grants = await client.getScopeGrants();
        outputChannel.appendLine("\n=== Scope Status ===");
        outputChannel.appendLine(`Level: ${status.scope_level}`);
        outputChannel.appendLine(`Axes: ${JSON.stringify(status.run_scope)}`);
        outputChannel.appendLine(`Contracts: ${status.contracts_count}`);
        outputChannel.appendLine(`Grants: ${grants.length}`);
        outputChannel.appendLine(`Escalations: ${status.escalation_count}`);
        if (grants.length > 0) {
          outputChannel.appendLine("\nGrants:");
          for (const g of grants) {
            outputChannel.appendLine(`  ${g.tool_id}: ${g.usage_count} uses${g.write ? " [W]" : ""}${g.execute ? " [X]" : ""}`);
          }
        }
        outputChannel.show();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Scope error: ${msg}`);
        outputChannel.show();
      }
    }),
    // V7.1: Show scar status
    vscode.commands.registerCommand("governor.showScars", async () => {
      try {
        const result = await client.getScarList();
        outputChannel.appendLine("\n=== Scar Status ===");
        outputChannel.appendLine(`Health: ${result.stats.health}`);
        outputChannel.appendLine(`Scars: ${result.stats.total_scars} (${result.stats.hard_scars} hard)`);
        outputChannel.appendLine(`Shields: ${result.stats.total_shields}`);
        if (result.scars.length > 0) {
          outputChannel.appendLine("\nScars:");
          for (const s of result.scars) {
            outputChannel.appendLine(`  ${s.region}: stiffness=${s.stiffness.toFixed(3)} ${s.is_hard ? "[HARD]" : "[soft]"}`);
          }
        }
        if (result.shields.length > 0) {
          outputChannel.appendLine("\nShields:");
          for (const s of result.shields) {
            const status = s.is_fully_blocked ? "BLOCKED" : `${Math.round(s.permeability * 100)}% open`;
            outputChannel.appendLine(`  ${s.source}: ${status}`);
          }
        }
        outputChannel.show();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Scar error: ${msg}`);
        outputChannel.show();
      }
    }),
    // V7.0: Run preflight manually
    vscode.commands.registerCommand("governor.runPreflight", async () => {
      const config = vscode.workspace.getConfiguration("governor");
      const agent = config.get<string>("preflight.agent", "claude");
      try {
        const result = await client.runPreflight(agent);
        outputChannel.appendLine(`\n=== Preflight (${agent}) ===`);
        for (const check of result.checks) {
          outputChannel.appendLine(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
        }
        outputChannel.appendLine(`Overall: ${result.overall}`);
        outputChannel.show();

        if (result.overall === "pass") {
          vscode.window.showInformationMessage("Governor: Preflight passed");
        } else {
          vscode.window.showWarningMessage("Governor: Preflight failed — see output");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Preflight error: ${msg}`);
        vscode.window.showErrorMessage(`Preflight failed: ${msg}`);
      }
    }),
  );

  // On-save handler
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const config = vscode.workspace.getConfiguration("governor");
      if (!config.get<boolean>("checkOnSave", false)) { return; }
      outputChannel.appendLine(`Auto-checking saved file: ${doc.uri.fsPath}`);
      try {
        const result = await client.checkFile(doc.uri.fsPath);
        diagnosticProvider.update(doc.uri, result);
        updateFindings(doc.uri, result.findings);
        updateStatusBar(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Auto-check error: ${msg}`);
      }
      treeProvider.refresh();
      hoverProvider?.invalidateCache();
      runSelfcheckRefresh();
    }),
  );

  // Clean up findings when documents close
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => { clearFindings(doc.uri); }),
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("governor.executablePath") || e.affectsConfiguration("governor.mode")) {
        client.updateConfig(getClientConfig());
      }
      if (e.affectsConfiguration("governor.correlator") || e.affectsConfiguration("governor.backgroundActivity")) {
        stopCorrelatorPolling();
        startCorrelatorPolling();
      }
    }),
  );

  // Workspace Trust: start background activity when trust is granted mid-session
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      outputChannel.appendLine("Workspace trusted — starting background activity.");
      runPreflightOnOpen();
      startCorrelatorPolling();
    }),
  );

  // Cleanup on deactivate
  context.subscriptions.push({ dispose: () => {
    stopCorrelatorPolling();
    client.dispose();
  }});

  // Initial load
  treeProvider.refresh();
  refreshIntent();
  runSelfcheckRefresh();

  // V7.0: Preflight on open + correlator polling
  runPreflightOnOpen();
  startCorrelatorPolling();

  outputChannel.appendLine("Agent Governor extension activated (V7.1 — Scope + Scars + Capture Alerts).");
}

export function deactivate(): void {
  // Cleanup handled by disposables in context.subscriptions
}
