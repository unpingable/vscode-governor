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

import { checkFile, checkStdin, runSelfcheck, getReceipts, getReceiptDetail } from "../../governor/client";
import type { CheckResult, SelfcheckResult, GateReceiptView } from "../../governor/types";

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
