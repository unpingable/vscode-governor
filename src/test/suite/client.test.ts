// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the governor CLI client wrapper.
 *
 * Tests mock child_process.spawn to avoid requiring the actual governor binary.
 */

import { EventEmitter } from "events";
import { Readable, Writable } from "stream";

// Mock child_process before importing client
const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  spawn: mockSpawn,
}));

import { GovernorClient, checkFile, checkStdin, runSelfcheck, getReceipts, getReceiptDetail, getScopeStatus, getScopeGrants, getScarList, getScarHistory } from "../../governor/client";
import type { CheckResult, SelfcheckResult, GateReceiptView, ScopeStatusView, ScopeGrantView, ScarListResult, FailureEventView, DoctorResult } from "../../governor/types";

function createMockProcess(
  stdoutData: string,
  stderrData: string,
  exitCode: number
) {
  const proc = new EventEmitter() as any;

  const stdoutStream = new Readable({
    read() {
      this.push(stdoutData);
      this.push(null);
    },
  });
  const stderrStream = new Readable({
    read() {
      this.push(stderrData);
      this.push(null);
    },
  });

  const stdinChunks: string[] = [];
  const stdinStream = new Writable({
    write(chunk, _encoding, callback) {
      stdinChunks.push(chunk.toString());
      callback();
    },
  });

  proc.stdout = stdoutStream;
  proc.stderr = stderrStream;
  proc.stdin = stdinStream;
  proc._stdinChunks = stdinChunks;

  // Emit close after streams are consumed
  setTimeout(() => proc.emit("close", exitCode), 10);

  return proc;
}

const defaultOpts = { executablePath: "governor", cwd: "/tmp" };

const passResult: CheckResult = {
  status: "pass",
  findings: [],
  summary: "No issues found.",
};

describe("checkFile", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("spawns governor with correct args", async () => {
    const proc = createMockProcess(JSON.stringify(passResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    await checkFile("/path/to/file.py", defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["check", "/path/to/file.py", "--format", "json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("returns parsed CheckResult on success", async () => {
    const expected: CheckResult = {
      status: "error",
      findings: [
        {
          code: "SECURITY.SECRET_LEAK",
          message: "API key detected",
          severity: "error",
          source: "security",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 20 },
          },
        },
      ],
      summary: "Found 1 issue(s): 1 error(s).",
    };
    const proc = createMockProcess(JSON.stringify(expected), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await checkFile("/file.py", defaultOpts);
    expect(result.status).toBe("error");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].code).toBe("SECURITY.SECRET_LEAK");
  });

  it("rejects on non-zero exit code", async () => {
    const proc = createMockProcess("", "Error: file not found", 1);
    mockSpawn.mockReturnValue(proc);

    await expect(checkFile("/missing.py", defaultOpts)).rejects.toThrow(
      /exited with code 1/
    );
  });

  it("rejects on invalid JSON output", async () => {
    const proc = createMockProcess("not json", "", 0);
    mockSpawn.mockReturnValue(proc);

    await expect(checkFile("/file.py", defaultOpts)).rejects.toThrow(
      /Failed to parse/
    );
  });

  it("rejects on spawn error", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
    mockSpawn.mockReturnValue(proc);

    const promise = checkFile("/file.py", defaultOpts);
    setTimeout(() => proc.emit("error", new Error("ENOENT")), 5);

    await expect(promise).rejects.toThrow(/Failed to spawn/);
  });
});

describe("checkStdin", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("sends JSON to stdin", async () => {
    const proc = createMockProcess(JSON.stringify(passResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    await checkStdin(
      { content: "x = 1", filepath: "test.py" },
      defaultOpts
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["check", "--stdin", "--format", "json"],
      expect.anything()
    );
    // Verify stdin received data
    expect(proc._stdinChunks.join("")).toContain('"content"');
  });

  it("returns parsed result from stdin check", async () => {
    const proc = createMockProcess(JSON.stringify(passResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await checkStdin(
      { content: "clean code", filepath: "f.py" },
      defaultOpts
    );
    expect(result.status).toBe("pass");
  });

  it("uses custom executable path", async () => {
    const proc = createMockProcess(JSON.stringify(passResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    const opts = { executablePath: "/usr/local/bin/governor", cwd: "/home" };
    await checkStdin({ content: "x", filepath: "f.py" }, opts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/local/bin/governor",
      expect.anything(),
      expect.objectContaining({ cwd: "/home" })
    );
  });
});

describe("runSelfcheck", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  const selfcheckResult: SelfcheckResult = {
    items: [
      { name: "governor_dir", status: "ok", detail: ".governor exists" },
      { name: "pre_commit_hook", status: "warn", detail: "hook not installed" },
    ],
    overall: "ok",
  };

  it("spawns governor selfcheck with correct args", async () => {
    const proc = createMockProcess(JSON.stringify(selfcheckResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    await runSelfcheck(defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["selfcheck", "--json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("passes --full flag when requested", async () => {
    const proc = createMockProcess(JSON.stringify(selfcheckResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    await runSelfcheck(defaultOpts, { full: true });

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["selfcheck", "--json", "--full"],
      expect.anything()
    );
  });

  it("parses selfcheck result", async () => {
    const proc = createMockProcess(JSON.stringify(selfcheckResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await runSelfcheck(defaultOpts);
    expect(result.overall).toBe("ok");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("governor_dir");
  });
});

describe("getReceipts", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  const receipts: GateReceiptView[] = [
    {
      receipt_id: "abc123",
      schema_version: 1,
      timestamp: "2025-01-01T00:00:00Z",
      gate: "evidence_gate",
      verdict: "pass",
      subject_hash: "s1",
      evidence_hash: "e1",
      policy_hash: "p1",
    },
    {
      receipt_id: "def456",
      schema_version: 1,
      timestamp: "2025-01-01T00:01:00Z",
      gate: "pre_commit",
      verdict: "block",
      subject_hash: "s2",
      evidence_hash: "e2",
      policy_hash: "p2",
    },
  ];

  it("spawns governor receipts with correct args", async () => {
    const proc = createMockProcess(JSON.stringify(receipts), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getReceipts(defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["receipts", "--json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("passes filter options", async () => {
    const proc = createMockProcess(JSON.stringify(receipts), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getReceipts(defaultOpts, { gate: "evidence_gate", verdict: "pass", last: 10 });

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["receipts", "--json", "--gate", "evidence_gate", "--verdict", "pass", "--last", "10"],
      expect.anything()
    );
  });

  it("parses receipt array", async () => {
    const proc = createMockProcess(JSON.stringify(receipts), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await getReceipts(defaultOpts);
    expect(result).toHaveLength(2);
    expect(result[0].gate).toBe("evidence_gate");
    expect(result[1].verdict).toBe("block");
  });
});

describe("getReceiptDetail", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  const receipt: GateReceiptView = {
    receipt_id: "abc123",
    schema_version: 1,
    timestamp: "2025-01-01T00:00:00Z",
    gate: "evidence_gate",
    verdict: "pass",
    subject_hash: "s1",
    evidence_hash: "e1",
    policy_hash: "p1",
  };

  it("spawns with --id flag", async () => {
    const proc = createMockProcess(JSON.stringify(receipt), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getReceiptDetail(defaultOpts, "abc123");

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["receipts", "--id", "abc123", "--json"],
      expect.anything()
    );
  });

  it("includes --evidence flag when requested", async () => {
    const proc = createMockProcess(JSON.stringify({ ...receipt, evidence: { key: "val" } }), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getReceiptDetail(defaultOpts, "abc123", true);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["receipts", "--id", "abc123", "--json", "--evidence"],
      expect.anything()
    );
  });

  it("parses single receipt", async () => {
    const proc = createMockProcess(JSON.stringify(receipt), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await getReceiptDetail(defaultOpts, "abc123");
    expect(result.receipt_id).toBe("abc123");
    expect(result.gate).toBe("evidence_gate");
  });
});

// =========================================================================
// V7.1: getScopeStatus
// =========================================================================

describe("getScopeStatus", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const scopeStatus: ScopeStatusView = {
    run_scope: { region: "us-east-1" },
    contracts_count: 2,
    grants_count: 1,
    escalation_count: 0,
    scope_level: 1,
  };

  it("spawns with correct args", async () => {
    const proc = createMockProcess(JSON.stringify(scopeStatus), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getScopeStatus(defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["scope", "status", "--json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("parses scope status result", async () => {
    const proc = createMockProcess(JSON.stringify(scopeStatus), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await getScopeStatus(defaultOpts);
    expect(result.run_scope.region).toBe("us-east-1");
    expect(result.contracts_count).toBe(2);
  });
});

// =========================================================================
// V7.1: getScopeGrants
// =========================================================================

describe("getScopeGrants", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const grants: ScopeGrantView[] = [{
    grant_id: "g1",
    tool_id: "file_write",
    axes: { region: "us-east-1" },
    granted_at: "2025-01-01T00:00:00Z",
    expires_at: null,
    usage_count: 3,
    write: true,
    execute: false,
  }];

  it("spawns with correct args", async () => {
    const proc = createMockProcess(JSON.stringify(grants), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getScopeGrants(defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["scope", "grants", "--json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("parses grants array", async () => {
    const proc = createMockProcess(JSON.stringify(grants), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await getScopeGrants(defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].tool_id).toBe("file_write");
    expect(result[0].write).toBe(true);
  });
});

// =========================================================================
// V7.1: getScarList
// =========================================================================

describe("getScarList", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const scarList: ScarListResult = {
    scars: [{ scar_id: "s1", region: "api", stiffness: 0.95, failure_kind: "", action_type: "", description: "", evidence_count: 0, required_evidence: 3, provenance: "internal", is_hard: true }],
    shields: [],
    stats: { total_scars: 1, hard_scars: 1, total_shields: 0, health: "CONSTRAINED" },
  };

  it("spawns with correct args", async () => {
    const proc = createMockProcess(JSON.stringify(scarList), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getScarList(defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["scar", "list", "--json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("parses scar list result", async () => {
    const proc = createMockProcess(JSON.stringify(scarList), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await getScarList(defaultOpts);
    expect(result.scars).toHaveLength(1);
    expect(result.stats.health).toBe("CONSTRAINED");
  });

  it("rejects on error", async () => {
    const proc = createMockProcess("", "Error", 1);
    mockSpawn.mockReturnValue(proc);

    await expect(getScarList(defaultOpts)).rejects.toThrow(/exited with code 1/);
  });
});

// =========================================================================
// V7.1: getScarHistory
// =========================================================================

describe("getScarHistory", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const events: FailureEventView[] = [{
    event_id: "ev1",
    timestamp: "2025-01-01T00:00:00Z",
    region: "api",
    failure_kind: "timeout",
    action_type: "write",
    description: "test",
    surprise_ratio: 0.1,
    provenance: "internal",
    response_type: "scar",
    scar_id: "s1",
    shield_id: null,
  }];

  it("spawns with correct args and default limit", async () => {
    const proc = createMockProcess(JSON.stringify(events), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getScarHistory(defaultOpts);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["scar", "history", "--json", "--limit", "20"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("passes custom limit", async () => {
    const proc = createMockProcess(JSON.stringify(events), "", 0);
    mockSpawn.mockReturnValue(proc);

    await getScarHistory(defaultOpts, 5);

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["scar", "history", "--json", "--limit", "5"],
      expect.anything()
    );
  });

  it("parses failure event array", async () => {
    const proc = createMockProcess(JSON.stringify(events), "", 0);
    mockSpawn.mockReturnValue(proc);

    const result = await getScarHistory(defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].event_id).toBe("ev1");
    expect(result[0].surprise_ratio).toBe(0.1);
  });
});

// =========================================================================
// V7.1: runDoctor
// =========================================================================

describe("runDoctor", () => {
  beforeEach(() => { mockSpawn.mockReset(); });

  const doctorResult: DoctorResult = {
    schema_version: 1,
    checks: [
      { name: "envelope", status: "ok", summary: "envelope set", next_commands: [] },
      { name: "scars", status: "warn", summary: "3 hard scars", next_commands: ["governor scar list"] },
    ],
    counts: { ok: 1, info: 0, warn: 1, error: 0 },
  };

  it("spawns governor doctor --json", async () => {
    const proc = createMockProcess(JSON.stringify(doctorResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    const client = new GovernorClient(defaultOpts);
    await client.runDoctor();

    expect(mockSpawn).toHaveBeenCalledWith(
      "governor",
      ["doctor", "--json"],
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("parses result on exit 0 (all ok)", async () => {
    const proc = createMockProcess(JSON.stringify(doctorResult), "", 0);
    mockSpawn.mockReturnValue(proc);

    const client = new GovernorClient(defaultOpts);
    const result = await client.runDoctor();
    expect(result.schema_version).toBe(1);
    expect(result.checks).toHaveLength(2);
    expect(result.counts.ok).toBe(1);
    expect(result.counts.warn).toBe(1);
  });

  it("parses result on exit 1 (findings present)", async () => {
    const proc = createMockProcess(JSON.stringify(doctorResult), "", 1);
    mockSpawn.mockReturnValue(proc);

    const client = new GovernorClient(defaultOpts);
    const result = await client.runDoctor();
    // Key test: exit 1 is NOT an error for doctor
    expect(result.checks).toHaveLength(2);
    expect(result.counts.warn).toBe(1);
  });

  it("rejects on exit >= 2", async () => {
    const proc = createMockProcess("", "internal error", 2);
    mockSpawn.mockReturnValue(proc);

    const client = new GovernorClient(defaultOpts);
    await expect(client.runDoctor()).rejects.toThrow(/exited with code 2/);
  });

  it("rejects on invalid JSON", async () => {
    const proc = createMockProcess("not json at all", "", 0);
    mockSpawn.mockReturnValue(proc);

    const client = new GovernorClient(defaultOpts);
    await expect(client.runDoctor()).rejects.toThrow(/Failed to parse/);
  });
});
