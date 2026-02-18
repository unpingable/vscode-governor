// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for V7.1 doctor diagnostics: virtual doc provider + Problems panel.
 */

import * as vscode from "vscode";
import {
  DOCTOR_URI,
  DoctorContentProvider,
  buildDoctorDiagnostics,
  clearDoctorDiagnostics,
  renderDoctorReport,
  sanitizeCheckName,
  setDoctorDiagnostics,
} from "../../doctor-diagnostics";
import type { DoctorResult, DoctorCheck } from "../../governor/types";

function mkResult(checks: DoctorCheck[]): DoctorResult {
  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const c of checks) { counts[c.status] += 1; }
  return { schema_version: 1, checks, counts };
}

function mkCheck(
  name: string,
  status: DoctorCheck["status"],
  summary = "test summary",
  next_commands: string[] = [],
): DoctorCheck {
  return { name, status, summary, next_commands };
}

// =========================================================================
// sanitizeCheckName
// =========================================================================

describe("sanitizeCheckName", () => {
  it("uppercases simple name", () => {
    expect(sanitizeCheckName("scars")).toBe("SCARS");
  });

  it("replaces slashes with underscores", () => {
    expect(sanitizeCheckName("scope/grants")).toBe("SCOPE_GRANTS");
  });

  it("replaces spaces and hyphens", () => {
    expect(sanitizeCheckName("my-check name")).toBe("MY_CHECK_NAME");
  });

  it("handles already uppercase", () => {
    expect(sanitizeCheckName("ENVELOPE")).toBe("ENVELOPE");
  });

  it("collapses different names to same token (known limitation)", () => {
    // "scope/grants" and "scope grants" both become "SCOPE_GRANTS"
    // This is acceptable — governor check names don't contain / or spaces
    expect(sanitizeCheckName("scope/grants")).toBe(sanitizeCheckName("scope grants"));
  });

  it("does not collapse distinct governor check names", () => {
    // The 9 actual governor doctor check names are all simple identifiers
    const names = ["envelope", "regime", "drift", "scars", "correlator", "scope", "stability", "violations", "receipts"];
    const sanitized = names.map(sanitizeCheckName);
    const unique = new Set(sanitized);
    expect(unique.size).toBe(names.length);
  });
});

// =========================================================================
// renderDoctorReport
// =========================================================================

describe("renderDoctorReport", () => {
  it("returns placeholder when null", () => {
    const s = renderDoctorReport(null);
    expect(s).toContain("No doctor report available");
    expect(s).toContain("Governor: Run Doctor Checks");
  });

  it("shows counts for all-ok result", () => {
    const r = mkResult([mkCheck("envelope", "ok")]);
    const s = renderDoctorReport(r);
    expect(s).toContain("ok=1");
    expect(s).toContain("info=0");
    expect(s).toContain("warn=0");
    expect(s).toContain("error=0");
  });

  it("shows check details with status", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred")]);
    const s = renderDoctorReport(r);
    expect(s).toContain("scars — WARN");
    expect(s).toContain("scarred");
  });

  it("renders next_commands", () => {
    const r = mkResult([
      mkCheck("scars", "warn", "scarred", ["governor scar list", "governor scar stats"]),
    ]);
    const s = renderDoctorReport(r);
    expect(s).toContain("`governor scar list`");
    expect(s).toContain("`governor scar stats`");
  });

  it("handles empty checks array", () => {
    const r = mkResult([]);
    const s = renderDoctorReport(r);
    expect(s).toContain("No checks returned");
  });

  it("shows no-summary fallback", () => {
    const r = mkResult([{ name: "test", status: "ok", summary: "", next_commands: [] }]);
    const s = renderDoctorReport(r);
    expect(s).toContain("_(no summary)_");
  });
});

// =========================================================================
// DoctorContentProvider
// =========================================================================

describe("DoctorContentProvider", () => {
  let provider: DoctorContentProvider;

  beforeEach(() => {
    provider = new DoctorContentProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  it("returns placeholder when no update called", () => {
    const content = provider.provideTextDocumentContent(DOCTOR_URI);
    expect(content).toContain("No doctor report available");
  });

  it("renders report after update", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred", ["governor scar list"])]);
    provider.update(r);
    const content = provider.provideTextDocumentContent(DOCTOR_URI);
    expect(content).toContain("scars — WARN");
    expect(content).toContain("governor scar list");
  });

  it("renders placeholder after update(null)", () => {
    const r = mkResult([mkCheck("envelope", "ok")]);
    provider.update(r);
    provider.update(null);
    const content = provider.provideTextDocumentContent(DOCTOR_URI);
    expect(content).toContain("No doctor report available");
  });

  it("fires onDidChange event on update", () => {
    const fired: vscode.Uri[] = [];
    provider.onDidChange((uri) => { fired.push(uri); });

    provider.update(mkResult([]));
    expect(fired).toHaveLength(1);
    expect(fired[0].toString()).toBe(DOCTOR_URI.toString());
  });
});

// =========================================================================
// buildDoctorDiagnostics
// =========================================================================

describe("buildDoctorDiagnostics", () => {
  it("produces no diagnostics for all-ok", () => {
    const r = mkResult([mkCheck("envelope", "ok"), mkCheck("regime", "ok")]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags).toHaveLength(0);
  });

  it("maps error to DiagnosticSeverity.Error", () => {
    const r = mkResult([mkCheck("violations", "error", "bad")]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Error);
  });

  it("maps warn to DiagnosticSeverity.Warning", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred")]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it("maps info to DiagnosticSeverity.Information", () => {
    const r = mkResult([mkCheck("drift", "info", "note")]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Information);
  });

  it("sets source to 'Governor Doctor'", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred")]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags[0].source).toBe("Governor Doctor");
  });

  it("sets code with sanitized name and target URI", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred")]);
    const diags = buildDoctorDiagnostics(r);
    const code = diags[0].code as { value: string; target: vscode.Uri };
    expect(code.value).toBe("GOVERNOR_DOCTOR_SCARS");
    expect(code.target.toString()).toBe(DOCTOR_URI.toString());
  });

  it("includes first next_command in message", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred", ["governor scar list", "cmd2"])]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags[0].message).toContain("next: governor scar list");
    expect(diags[0].message).not.toContain("cmd2");
  });

  it("omits next_command clause when empty", () => {
    const r = mkResult([mkCheck("scars", "warn", "scarred", [])]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags[0].message).not.toContain("next:");
    expect(diags[0].message).toBe("scars: scarred");
  });

  it("creates multiple diagnostics for multiple non-ok checks", () => {
    const r = mkResult([
      mkCheck("scars", "warn", "scarred"),
      mkCheck("envelope", "ok"),
      mkCheck("violations", "error", "bad"),
      mkCheck("drift", "info", "note"),
    ]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags).toHaveLength(3);

    const codes = diags.map((d) => (d.code as { value: string }).value);
    expect(codes).toContain("GOVERNOR_DOCTOR_SCARS");
    expect(codes).toContain("GOVERNOR_DOCTOR_VIOLATIONS");
    expect(codes).toContain("GOVERNOR_DOCTOR_DRIFT");
  });

  it("handles empty checks array", () => {
    const r = mkResult([]);
    const diags = buildDoctorDiagnostics(r);
    expect(diags).toHaveLength(0);
  });

  it("sanitizes check name with special characters in code", () => {
    const r = mkResult([mkCheck("scope/grants", "warn", "test")]);
    const diags = buildDoctorDiagnostics(r);
    const code = diags[0].code as { value: string; target: vscode.Uri };
    expect(code.value).toBe("GOVERNOR_DOCTOR_SCOPE_GRANTS");
  });
});

// =========================================================================
// setDoctorDiagnostics / clearDoctorDiagnostics
// =========================================================================

describe("setDoctorDiagnostics", () => {
  it("sets diagnostics on DOCTOR_URI", () => {
    const col = vscode.languages.createDiagnosticCollection("test-doctor-set");
    const r = mkResult([mkCheck("scars", "warn", "scarred")]);

    setDoctorDiagnostics(col, r);

    const got = col.get(DOCTOR_URI) ?? [];
    expect(got).toHaveLength(1);
    expect(got[0].source).toBe("Governor Doctor");

    col.dispose();
  });

  it("sets empty array for all-ok result", () => {
    const col = vscode.languages.createDiagnosticCollection("test-doctor-ok");
    const r = mkResult([mkCheck("envelope", "ok")]);

    setDoctorDiagnostics(col, r);

    const got = col.get(DOCTOR_URI) ?? [];
    expect(got).toHaveLength(0);

    col.dispose();
  });
});

describe("clearDoctorDiagnostics", () => {
  it("removes diagnostics from collection", () => {
    const col = vscode.languages.createDiagnosticCollection("test-doctor-clear");
    const r = mkResult([mkCheck("scars", "warn", "scarred")]);

    setDoctorDiagnostics(col, r);
    expect((col.get(DOCTOR_URI) ?? []).length).toBe(1);

    clearDoctorDiagnostics(col);
    const got = col.get(DOCTOR_URI);
    expect(!got || got.length === 0).toBe(true);

    col.dispose();
  });

  it("is safe on empty collection", () => {
    const col = vscode.languages.createDiagnosticCollection("test-doctor-empty");
    clearDoctorDiagnostics(col);
    // No throw
    col.dispose();
  });
});
