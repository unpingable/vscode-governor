// SPDX-License-Identifier: Apache-2.0
/**
 * V7.1: Doctor diagnostics — virtual document + Problems panel integration.
 *
 * Maps `governor doctor --json` results to VS Code diagnostics. Non-ok checks
 * appear in the Problems panel. Clicking "More info" opens the virtual doc.
 *
 * Exports pure helpers (renderDoctorReport, buildDoctorDiagnostics,
 * sanitizeCheckName) so tests don't need VS Code UI objects.
 */

import * as vscode from "vscode";
import type { DoctorResult, DoctorCheck } from "./governor/types";

export const DOCTOR_URI = vscode.Uri.parse("governor-doctor://health/checks");

/**
 * Sanitize a check name into a safe diagnostic code token (A-Z0-9_).
 */
export function sanitizeCheckName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Render doctor report as plain text for the virtual document.
 */
export function renderDoctorReport(result: DoctorResult | null): string {
  if (!result) {
    return [
      "# Governor Doctor",
      "",
      "_No doctor report available yet._",
      "",
      "Run: `Governor: Run Doctor Checks`",
      "",
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("# Governor Doctor");
  lines.push("");
  lines.push(
    `Counts: ok=${result.counts.ok} info=${result.counts.info} warn=${result.counts.warn} error=${result.counts.error}`,
  );
  lines.push("");

  if (!result.checks || result.checks.length === 0) {
    lines.push("_No checks returned._");
    lines.push("");
    return lines.join("\n");
  }

  for (const c of result.checks) {
    lines.push(`## ${c.name} — ${c.status.toUpperCase()}`);
    lines.push("");
    lines.push(c.summary || "_(no summary)_");
    lines.push("");

    if (c.next_commands && c.next_commands.length > 0) {
      lines.push("Next commands:");
      for (const cmd of c.next_commands) {
        lines.push(`- \`${cmd}\``);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function statusToSeverity(status: DoctorCheck["status"]): vscode.DiagnosticSeverity {
  switch (status) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warn":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
    case "ok":
    default:
      return vscode.DiagnosticSeverity.Hint; // won't be reached; ok is skipped
  }
}

/**
 * Build diagnostic objects from doctor checks. Pure function — no collection needed.
 * Diagnostic codes link to the virtual doc via code.target for clickable "More info".
 */
export function buildDoctorDiagnostics(result: DoctorResult): vscode.Diagnostic[] {
  const diags: vscode.Diagnostic[] = [];

  for (const c of result.checks || []) {
    if (c.status === "ok") { continue; }

    const severity = statusToSeverity(c.status);
    const next = (c.next_commands && c.next_commands.length > 0) ? c.next_commands[0] : null;

    const msg = next
      ? `${c.name}: ${c.summary} (next: ${next})`
      : `${c.name}: ${c.summary}`;

    const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), msg, severity);
    d.source = "Governor Doctor";
    d.code = { value: `GOVERNOR_DOCTOR_${sanitizeCheckName(c.name)}`, target: DOCTOR_URI };

    diags.push(d);
  }

  return diags;
}

/**
 * Set doctor diagnostics in the Problems panel.
 */
export function setDoctorDiagnostics(
  collection: vscode.DiagnosticCollection,
  result: DoctorResult,
): void {
  const diags = buildDoctorDiagnostics(result);
  collection.set(DOCTOR_URI, diags);
}

/**
 * Clear all doctor diagnostics from the Problems panel.
 */
export function clearDoctorDiagnostics(collection: vscode.DiagnosticCollection): void {
  collection.delete(DOCTOR_URI);
}

/**
 * Virtual document content provider for doctor report detail.
 * Registered on the "governor-doctor" scheme.
 */
export class DoctorContentProvider implements vscode.TextDocumentContentProvider {
  private _result: DoctorResult | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this._onDidChange.event;

  update(result: DoctorResult | null): void {
    this._result = result;
    this._onDidChange.fire(DOCTOR_URI);
  }

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return renderDoctorReport(this._result);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
