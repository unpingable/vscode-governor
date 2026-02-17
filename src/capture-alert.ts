// SPDX-License-Identifier: Apache-2.0
/**
 * V7.1: Capture alert — virtual document + Problems panel integration.
 *
 * When the correlator detects capture (with hysteresis), a Warning diagnostic
 * appears in the Problems panel. Clicking it opens a virtual document with
 * detailed K-vector and indicator information.
 */

import * as vscode from "vscode";
import type { CorrelatorStatus } from "./governor/types";

const CAPTURE_URI = vscode.Uri.parse("agent-governor://correlator/capture");

/**
 * Virtual document content provider for capture details.
 * Registered on the "agent-governor" scheme.
 */
export class CaptureAlertProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private lastStatus: CorrelatorStatus | null = null;

  updateStatus(status: CorrelatorStatus): void {
    this.lastStatus = status;
    this._onDidChange.fire(CAPTURE_URI);
  }

  provideTextDocumentContent(_uri: vscode.Uri): string {
    if (!this.lastStatus) {
      return "No correlator status available.";
    }

    const s = this.lastStatus;
    const k = s.kvector;
    const activeIndicators = s.capture_indicators.filter((i) => i.active);

    const lines: string[] = [
      "=== Governor Correlator: Capture Detected ===",
      "",
      `Regime:   ${s.regime}`,
      `Captured: ${s.is_captured}`,
      "",
      "K-Vector (never scalarised):",
      `  Throughput: ${k.throughput}`,
      `  Fidelity:   ${k.fidelity}`,
      `  Authority:  ${k.authority}`,
      `  Cost:       ${k.cost}`,
      "",
      "Active Capture Indicators:",
    ];

    if (activeIndicators.length > 0) {
      for (const ind of activeIndicators) {
        lines.push(`  [ACTIVE] ${ind.name}: ${ind.consecutive_windows}/${ind.threshold} consecutive windows`);
      }
    } else {
      lines.push("  (none active)");
    }

    lines.push("");
    lines.push("All Indicators:");
    for (const ind of s.capture_indicators) {
      const marker = ind.active ? "[ACTIVE]" : "[      ]";
      lines.push(`  ${marker} ${ind.name}: ${ind.consecutive_windows}/${ind.threshold} windows`);
    }

    if (s.last_observation) {
      lines.push("");
      lines.push(`Last observation: ${s.last_observation}`);
    }

    lines.push("");
    lines.push("---");
    lines.push("Capture means the governor may be adapting to the agent rather than");
    lines.push("constraining it. Review K-vector dimensions and active indicators.");
    lines.push("See: https://github.com/unpingable/agent_governor#correlator");

    return lines.join("\n");
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Set a capture alert in the Problems panel.
 * Message kept short; detail goes in the virtual document.
 */
export function setCaptureAlert(
  diagnostics: vscode.DiagnosticCollection,
  status: CorrelatorStatus,
): void {
  const activeNames = status.capture_indicators
    .filter((i) => i.active)
    .map((i) => i.name);

  const k = status.kvector;
  const kvStr = `T:${k.throughput.toFixed(1)} F:${k.fidelity.toFixed(1)} A:${k.authority.toFixed(1)} C:${k.cost.toFixed(1)}`;

  const message = `Capture detected: ${activeNames.join(", ")} | K:[${kvStr}]. Open capture details: agent-governor://correlator/capture`;

  const diag = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    message,
    vscode.DiagnosticSeverity.Warning,
  );
  diag.source = "Governor Correlator";
  diag.code = "GOVERNOR_CAPTURE_DETECTED";

  diagnostics.set(CAPTURE_URI, [diag]);
}

/**
 * Clear the capture alert from the Problems panel.
 */
export function clearCaptureAlert(diagnostics: vscode.DiagnosticCollection): void {
  diagnostics.set(CAPTURE_URI, []);
}
