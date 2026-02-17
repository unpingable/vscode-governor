// SPDX-License-Identifier: Apache-2.0
/**
 * GovernorClient: structured CLI wrapper with transport abstraction.
 *
 * All governor interactions go through this class. The transport layer
 * (currently CLI-only) can be swapped for RPC when remote governor lands.
 */

import { spawn, ChildProcess } from "child_process";
import type {
  CheckResult, CheckInput, GovernorViewModelV2, IntentResult,
  OverrideView, CodeDivergenceReportView, SelfcheckResult,
  GateReceiptView, PreflightResult, CorrelatorStatus,
} from "./types";

// =========================================================================
// Transport abstraction
// =========================================================================

interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  stdin?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface GovernorClientConfig {
  executablePath: string;
  cwd: string;
}

/**
 * Capability flags — probed once, cached for session lifetime.
 * Each flag corresponds to a CLI subcommand that may or may not exist.
 */
export interface CapabilitySet {
  preflight: boolean;
  correlator: boolean;
  scope: boolean;
  kernel: boolean;
  oracle: boolean;
  scar: boolean;
  drift: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 60_000;

// Force deterministic output from CLI.
// LC_ALL=C only on non-Windows (Windows locale handling is different).
const CLI_ENV: Record<string, string> = {
  NO_COLOR: "1",
  ...(process.platform !== "win32" ? { LC_ALL: "C" } : {}),
};

/**
 * GovernorClient — single entry point for all governor CLI interactions.
 *
 * Design constraints (V7 plan):
 * - All execution goes through execJson/execVoid (no direct spawn elsewhere)
 * - Environment discipline: LC_ALL=C, NO_COLOR=1 on all spawns
 * - Feature detection via probe-once-cache
 * - Transport abstraction: CLI now, RPC later (swap transport, not callers)
 */
export class GovernorClient {
  private config: GovernorClientConfig;
  private capabilities: CapabilitySet | null = null;
  private capabilityProbe: Promise<CapabilitySet> | null = null;
  /** The binary path that was used when capabilities were probed. */
  private capabilitiesProbedFor: string | null = null;
  private inflight = new Map<string, ChildProcess>();

  constructor(config: GovernorClientConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<GovernorClientConfig>): void {
    const oldPath = this.config.executablePath;
    this.config = { ...this.config, ...config };
    // Reset capabilities when binary path changes (different binary = different features)
    if (config.executablePath && config.executablePath !== oldPath) {
      this.capabilities = null;
      this.capabilityProbe = null;
      this.capabilitiesProbedFor = null;
    }
  }

  // =========================================================================
  // Core execution
  // =========================================================================

  private execute(args: string[], opts: ExecOptions = {}): Promise<RawResult> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.executablePath, args, {
        cwd: this.config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        timeout,
        env: { ...process.env, ...CLI_ENV },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err: Error) => {
        reject(new Error(`Failed to spawn governor: ${err.message}`));
      });

      proc.on("close", (code: number | null) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      // Wire abort signal to kill
      if (opts.signal) {
        if (opts.signal.aborted) {
          proc.kill();
          reject(new Error("Aborted"));
          return;
        }
        opts.signal.addEventListener("abort", () => { proc.kill(); }, { once: true });
      }

      if (opts.stdin !== undefined) {
        proc.stdin.write(opts.stdin);
      }
      proc.stdin.end();
    });
  }

  /**
   * Execute a governor command and parse JSON output.
   * Rejects on non-zero exit or JSON parse failure.
   */
  async execJson<T>(args: string[], opts: ExecOptions = {}): Promise<T> {
    const result = await this.execute(args, opts);
    if (result.exitCode !== 0) {
      throw new Error(`governor exited with code ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(`Failed to parse governor output: ${result.stdout.slice(0, 200)}`);
    }
  }

  /**
   * Execute a governor command that produces no JSON output.
   * Rejects on non-zero exit.
   */
  async execVoid(args: string[], opts: ExecOptions = {}): Promise<void> {
    const result = await this.execute(args, opts);
    if (result.exitCode !== 0) {
      throw new Error(`governor exited with code ${result.exitCode}: ${result.stderr}`);
    }
  }

  /**
   * Probe a command — returns true if it exits 0, false otherwise.
   * Used for feature detection.
   */
  private async probe(args: string[]): Promise<boolean> {
    try {
      const result = await this.execute(args, { timeout: 5_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Feature detection
  // =========================================================================

  /**
   * Probe available capabilities. Called once, cached.
   * Each probe tries a lightweight command (--help or status).
   */
  async getCapabilities(): Promise<CapabilitySet> {
    // Invalidate if binary path changed since last probe
    if (this.capabilities && this.capabilitiesProbedFor !== this.config.executablePath) {
      this.capabilities = null;
      this.capabilityProbe = null;
    }

    if (this.capabilities) {
      return this.capabilities;
    }

    // Deduplicate concurrent probes
    if (!this.capabilityProbe) {
      this.capabilityProbe = this.probeAll();
    }

    this.capabilities = await this.capabilityProbe;
    this.capabilitiesProbedFor = this.config.executablePath;
    this.capabilityProbe = null;
    return this.capabilities;
  }

  private async probeAll(): Promise<CapabilitySet> {
    const [preflight, correlator, scope, kernel, scar, drift] = await Promise.all([
      this.probe(["preflight", "--help"]),
      this.probe(["correlator", "--help"]),
      this.probe(["scope", "--help"]),
      this.probe(["kernel", "--help"]),
      this.probe(["scar", "--help"]),
      this.probe(["drift", "--help"]),
    ]);

    // Oracle is a flag on gate check, not a subcommand — probe differently
    const oracle = await this.probe(["gate", "check", "--help"]);

    return { preflight, correlator, scope, kernel, oracle, scar, drift };
  }

  hasCapability(name: keyof CapabilitySet): boolean {
    return this.capabilities?.[name] ?? false;
  }

  // =========================================================================
  // File checking
  // =========================================================================

  checkFile(filePath: string): Promise<CheckResult> {
    return this.execJson<CheckResult>(["check", filePath, "--format", "json"]);
  }

  checkStdin(input: CheckInput): Promise<CheckResult> {
    return this.execJson<CheckResult>(
      ["check", "--stdin", "--format", "json"],
      { stdin: JSON.stringify(input) },
    );
  }

  // =========================================================================
  // State
  // =========================================================================

  fetchState(): Promise<GovernorViewModelV2> {
    return this.execJson<GovernorViewModelV2>(["state", "--json", "--schema", "v2"]);
  }

  // =========================================================================
  // Intent management
  // =========================================================================

  getIntent(): Promise<IntentResult> {
    return this.execJson<IntentResult>(["intent", "show", "--json"]);
  }

  async setIntent(intentOpts: SetIntentOptions): Promise<void> {
    const args = ["intent", "set", "--profile", intentOpts.profile];
    if (intentOpts.scope) {
      for (const s of intentOpts.scope) { args.push("--scope", s); }
    }
    if (intentOpts.deny) {
      for (const d of intentOpts.deny) { args.push("--deny", d); }
    }
    if (intentOpts.timebox !== undefined) {
      args.push("--timebox", String(intentOpts.timebox));
    }
    if (intentOpts.reason) {
      args.push("--because", intentOpts.reason);
    }
    return this.execVoid(args);
  }

  clearIntent(): Promise<void> {
    return this.execVoid(["intent", "clear"]);
  }

  // =========================================================================
  // Overrides
  // =========================================================================

  listOverrides(includeAll = false): Promise<OverrideView[]> {
    const args = ["override", "list", "--json"];
    if (includeAll) { args.push("--all"); }
    return this.execJson<OverrideView[]>(args);
  }

  // =========================================================================
  // Code Interferometry
  // =========================================================================

  runCodeCompare(runId?: string): Promise<CodeDivergenceReportView> {
    const args = ["interferometry", "compare"];
    if (runId) { args.push("--id", runId); } else { args.push("--last"); }
    args.push("--json");
    return this.execJson<CodeDivergenceReportView>(args);
  }

  // =========================================================================
  // Selfcheck
  // =========================================================================

  runSelfcheck(full = false): Promise<SelfcheckResult> {
    const args = ["selfcheck", "--json"];
    if (full) { args.push("--full"); }
    return this.execJson<SelfcheckResult>(args);
  }

  // =========================================================================
  // Gate Receipts
  // =========================================================================

  getReceipts(filters: ReceiptFilterOptions = {}): Promise<GateReceiptView[]> {
    const args = ["receipts", "--json"];
    if (filters.gate) { args.push("--gate", filters.gate); }
    if (filters.verdict) { args.push("--verdict", filters.verdict); }
    if (filters.last !== undefined) { args.push("--last", String(filters.last)); }
    return this.execJson<GateReceiptView[]>(args);
  }

  getReceiptDetail(receiptId: string, includeEvidence = false): Promise<GateReceiptView> {
    const args = ["receipts", "--id", receiptId, "--json"];
    if (includeEvidence) { args.push("--evidence"); }
    return this.execJson<GateReceiptView>(args);
  }

  // =========================================================================
  // V7.0: Preflight
  // =========================================================================

  runPreflight(agent = "claude"): Promise<PreflightResult> {
    return this.execJson<PreflightResult>(["preflight", "--agent", agent, "--json"]);
  }

  // =========================================================================
  // V7.0: Correlator
  // =========================================================================

  getCorrelatorStatus(): Promise<CorrelatorStatus> {
    return this.execJson<CorrelatorStatus>(["correlator", "status", "--json"]);
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  dispose(): void {
    for (const proc of this.inflight.values()) {
      proc.kill();
    }
    this.inflight.clear();
  }
}

// =========================================================================
// Supporting types (kept here for backward compat)
// =========================================================================

export interface SetIntentOptions {
  profile: string;
  scope?: string[];
  deny?: string[];
  timebox?: number;
  reason?: string;
}

export interface ReceiptFilterOptions {
  gate?: string;
  verdict?: string;
  last?: number;
}

// Re-export config type
export type { GovernorClientConfig as GovernorOptions };

// =========================================================================
// Backward-compat shims for governorTree.ts and other consumers.
// These create a temporary client per call. Prefer using GovernorClient directly.
// TODO: migrate governorTree.ts to use GovernorClient, then remove these.
// =========================================================================

export function checkFile(filePath: string, opts: GovernorClientConfig): Promise<import("./types").CheckResult> {
  return new GovernorClient(opts).checkFile(filePath);
}

export function checkStdin(input: import("./types").CheckInput, opts: GovernorClientConfig): Promise<import("./types").CheckResult> {
  return new GovernorClient(opts).checkStdin(input);
}

export function fetchState(opts: GovernorClientConfig): Promise<import("./types").GovernorViewModelV2> {
  return new GovernorClient(opts).fetchState();
}

export function getIntent(opts: GovernorClientConfig): Promise<import("./types").IntentResult> {
  return new GovernorClient(opts).getIntent();
}

export function setIntent(opts: GovernorClientConfig, intentOpts: SetIntentOptions): Promise<void> {
  return new GovernorClient(opts).setIntent(intentOpts);
}

export function clearIntent(opts: GovernorClientConfig): Promise<void> {
  return new GovernorClient(opts).clearIntent();
}

export function listOverrides(opts: GovernorClientConfig, includeAll = false): Promise<import("./types").OverrideView[]> {
  return new GovernorClient(opts).listOverrides(includeAll);
}

export function runCodeCompare(opts: GovernorClientConfig, runId?: string): Promise<import("./types").CodeDivergenceReportView> {
  return new GovernorClient(opts).runCodeCompare(runId);
}

export function runSelfcheck(opts: GovernorClientConfig, selfcheckOpts: { full?: boolean } = {}): Promise<import("./types").SelfcheckResult> {
  return new GovernorClient(opts).runSelfcheck(selfcheckOpts.full);
}

export function getReceipts(opts: GovernorClientConfig, filters: ReceiptFilterOptions = {}): Promise<import("./types").GateReceiptView[]> {
  return new GovernorClient(opts).getReceipts(filters);
}

export function getReceiptDetail(opts: GovernorClientConfig, receiptId: string, includeEvidence = false): Promise<import("./types").GateReceiptView> {
  return new GovernorClient(opts).getReceiptDetail(receiptId, includeEvidence);
}
