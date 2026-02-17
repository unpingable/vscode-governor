// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for V7.1 capture alert: virtual doc provider + Problems panel.
 */

import * as vscode from "vscode";
import { CaptureAlertProvider, setCaptureAlert, clearCaptureAlert } from "../../capture-alert";
import type { CorrelatorStatus, CaptureIndicator } from "../../governor/types";

function makeStatus(captured: boolean, indicators?: CaptureIndicator[]): CorrelatorStatus {
  return {
    regime: "NORMAL",
    kvector: { throughput: 0.8, fidelity: 0.9, authority: 0.5, cost: 0.3 },
    capture_indicators: indicators ?? [
      { name: "mode_per_exposure", active: captured, consecutive_windows: captured ? 5 : 0, threshold: 3 },
      { name: "entropy_decline", active: false, consecutive_windows: 0, threshold: 3 },
    ],
    is_captured: captured,
    last_observation: "2025-01-01T00:00:00Z",
  };
}

describe("CaptureAlertProvider", () => {
  let provider: CaptureAlertProvider;

  beforeEach(() => {
    provider = new CaptureAlertProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  it("returns placeholder text when no status", () => {
    const content = provider.provideTextDocumentContent(vscode.Uri.parse("agent-governor://correlator/capture"));
    expect(content).toContain("No correlator status");
  });

  it("returns formatted capture details after updateStatus", () => {
    const status = makeStatus(true);
    provider.updateStatus(status);

    const content = provider.provideTextDocumentContent(vscode.Uri.parse("agent-governor://correlator/capture"));
    expect(content).toContain("Capture Detected");
    expect(content).toContain("Throughput: 0.8");
    expect(content).toContain("Fidelity:   0.9");
    expect(content).toContain("mode_per_exposure");
    expect(content).toContain("[ACTIVE]");
    expect(content).toContain("5/3 consecutive windows");
  });

  it("shows K-vector values in virtual doc", () => {
    const status = makeStatus(false);
    provider.updateStatus(status);

    const content = provider.provideTextDocumentContent(vscode.Uri.parse("agent-governor://correlator/capture"));
    expect(content).toContain("Authority:  0.5");
    expect(content).toContain("Cost:       0.3");
  });
});

describe("setCaptureAlert", () => {
  it("creates diagnostic with GOVERNOR_CAPTURE_DETECTED code and Warning severity", () => {
    const collection = vscode.languages.createDiagnosticCollection("test-capture");
    const status = makeStatus(true, [
      { name: "mode_decline", active: true, consecutive_windows: 4, threshold: 3 },
      { name: "entropy", active: false, consecutive_windows: 0, threshold: 3 },
    ]);

    setCaptureAlert(collection, status);

    const uri = vscode.Uri.parse("agent-governor://correlator/capture");
    const diagnostics = collection.get(uri);
    expect(diagnostics).toBeDefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics![0].severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(diagnostics![0].code).toBe("GOVERNOR_CAPTURE_DETECTED");
    expect(diagnostics![0].source).toBe("Governor Correlator");

    collection.dispose();
  });

  it("includes K-vector values and indicator names in message", () => {
    const collection = vscode.languages.createDiagnosticCollection("test-capture-msg");
    const status = makeStatus(true, [
      { name: "mode_decline", active: true, consecutive_windows: 4, threshold: 3 },
    ]);

    setCaptureAlert(collection, status);

    const uri = vscode.Uri.parse("agent-governor://correlator/capture");
    const diagnostics = collection.get(uri)!;
    expect(diagnostics[0].message).toContain("mode_decline");
    expect(diagnostics[0].message).toContain("T:0.8");
    expect(diagnostics[0].message).toContain("F:0.9");

    collection.dispose();
  });
});

describe("clearCaptureAlert", () => {
  it("empties the diagnostic collection", () => {
    const collection = vscode.languages.createDiagnosticCollection("test-clear");
    const status = makeStatus(true);
    setCaptureAlert(collection, status);

    const uri = vscode.Uri.parse("agent-governor://correlator/capture");
    expect(collection.get(uri)).toHaveLength(1);

    clearCaptureAlert(collection);
    // After clearing, diagnostics should be empty
    const after = collection.get(uri);
    expect(!after || after.length === 0).toBe(true);

    collection.dispose();
  });
});
