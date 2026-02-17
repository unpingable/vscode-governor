// SPDX-License-Identifier: Apache-2.0
/**
 * TreeDataProvider for the Governor side panel.
 *
 * Renders the V2 GovernorViewModel schema: session, regime, decisions, claims,
 * evidence, violations, execution, stability.
 */

import * as vscode from "vscode";
import {
  fetchState, getIntent, listOverrides, runCodeCompare, getReceipts, runSelfcheck,
  getScopeStatus, getScopeGrants, getScarList, getScarHistory,
  GovernorOptions,
} from "../governor/client";
import type {
  GovernorViewModelV2,
  DecisionView,
  ClaimView,
  EvidenceView,
  ViolationView,
  ExecutionView,
  StabilityView,
  IntentResult,
  OverrideView,
  CodeDivergenceReportView,
  GateReceiptView,
  SelfcheckResult,
  ScopeStatusView,
  ScopeGrantView,
  ScarListResult,
  FailureEventView,
} from "../governor/types";

// =========================================================================
// Internal tree node type
// =========================================================================

export interface TreeNodeData {
  kind: string;
  label: string;
  description?: string;
  tooltip?: string;
  collapsible: boolean;
  icon?: string;
  children?: TreeNodeData[];
  /** JSON detail string shown in output channel on click */
  detail?: string;
}

// =========================================================================
// Icon helpers
// =========================================================================

const REGIME_ICONS: Record<string, string> = {
  elastic: "shield",
  warm: "warning",
  ductile: "flame",
  unstable: "error",
};

const DECISION_ICONS: Record<string, string> = {
  accepted: "check-all",
  rejected: "close",
  pending: "clock",
};

const CLAIM_ICONS: Record<string, string> = {
  stabilized: "check",
  proposed: "question",
  stale: "clock",
  contradicted: "close",
};

const VIOLATION_SEVERITY_ICONS: Record<string, string> = {
  low: "info",
  medium: "warning",
  high: "error",
  critical: "alert",
};

const PROFILE_ICONS: Record<string, string> = {
  greenfield: "beaker",       // Experimenting
  established: "shield",      // Normal (default)
  production: "lock",         // Strict
  hotfix: "flame",            // Urgent
  refactor: "tools",          // Restructuring
};

// =========================================================================
// GovernorTreeProvider
// =========================================================================

export class GovernorTreeProvider
  implements vscode.TreeDataProvider<TreeNodeData>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNodeData | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private state: GovernorViewModelV2 | null = null;
  private intent: IntentResult | null = null;
  private overrides: OverrideView[] = [];
  private compareReport: CodeDivergenceReportView | null = null;
  private receipts: GateReceiptView[] = [];
  private selfcheck: SelfcheckResult | null = null;
  private scopeStatus: ScopeStatusView | null = null;
  private scopeGrants: ScopeGrantView[] = [];
  private scarResult: ScarListResult | null = null;
  private scarHistory: FailureEventView[] = [];
  private error: string | null = null;

  constructor(
    private outputChannel: vscode.OutputChannel,
    private getOptions: () => GovernorOptions
  ) {}

  /**
   * Get the current intent (for status bar integration).
   */
  getIntent(): IntentResult | null {
    return this.intent;
  }

  /**
   * Get the current selfcheck result (for status bar integration).
   */
  getSelfcheck(): SelfcheckResult | null {
    return this.selfcheck;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  async refresh(): Promise<void> {
    try {
      // Fetch all state in parallel — keyed pattern prevents index drift
      const opts = this.getOptions();
      const fetchers: Record<string, Promise<unknown>> = {
        state: fetchState(opts),
        intent: getIntent(opts),
        overrides: listOverrides(opts),
        compare: runCodeCompare(opts),
        receipts: getReceipts(opts, { last: 20 }),
        selfcheck: runSelfcheck(opts),
        scopeStatus: getScopeStatus(opts),
        scopeGrants: getScopeGrants(opts),
        scarList: getScarList(opts),
        scarHistory: getScarHistory(opts),
      };

      const entries = Object.entries(fetchers);
      const settled = await Promise.allSettled(entries.map(([, p]) => p));
      const results: Record<string, unknown> = {};
      for (let i = 0; i < entries.length; i++) {
        const [key] = entries[i];
        const s = settled[i];
        results[key] = s.status === "fulfilled" ? s.value : null;
      }

      this.state = results.state as GovernorViewModelV2 | null;
      this.intent = results.intent as IntentResult | null;
      this.overrides = (results.overrides as OverrideView[] | null) ?? [];
      this.compareReport = results.compare as CodeDivergenceReportView | null;
      this.receipts = (results.receipts as GateReceiptView[] | null) ?? [];
      this.selfcheck = results.selfcheck as SelfcheckResult | null;
      this.scopeStatus = results.scopeStatus as ScopeStatusView | null;
      this.scopeGrants = (results.scopeGrants as ScopeGrantView[] | null) ?? [];
      this.scarResult = results.scarList as ScarListResult | null;
      this.scarHistory = (results.scarHistory as FailureEventView[] | null) ?? [];

      // Only set error if state fetch failed (everything else is optional)
      const stateSettled = settled[entries.findIndex(([k]) => k === "state")];
      this.error = stateSettled.status === "rejected"
        ? (stateSettled.reason instanceof Error ? stateSettled.reason.message : String(stateSettled.reason))
        : null;
    } catch (err: unknown) {
      this.state = null;
      this.intent = null;
      this.overrides = [];
      this.compareReport = null;
      this.receipts = [];
      this.selfcheck = null;
      this.scopeStatus = null;
      this.scopeGrants = [];
      this.scarResult = null;
      this.scarHistory = [];
      this.error = err instanceof Error ? err.message : String(err);
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNodeData): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.collapsible
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (element.description) {
      item.description = element.description;
    }
    if (element.tooltip) {
      item.tooltip = element.tooltip;
    }
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    if (element.detail) {
      item.command = {
        command: "governor.showDetail",
        title: "Show Detail",
        arguments: [element.detail],
      };
    }

    return item;
  }

  getChildren(element?: TreeNodeData): TreeNodeData[] {
    if (element) {
      return element.children ?? [];
    }

    // Root level
    if (this.error) {
      return [
        {
          kind: "error",
          label: "Error loading state",
          description: this.error,
          collapsible: false,
          icon: "error",
        },
      ];
    }

    if (!this.state) {
      return [
        {
          kind: "loading",
          label: "Loading...",
          collapsible: false,
          icon: "loading~spin",
        },
      ];
    }

    const nodes: TreeNodeData[] = [];

    // Per UX spec: Problems first (expanded if any), then Intent, then Decisions
    const violationsNode = this.buildViolationsNode(this.state);
    if (violationsNode) {
      nodes.push(violationsNode);
    }

    // Code Autopilot: Intent section (prominently displayed)
    nodes.push(this.buildIntentNode());

    // Code Interferometry: Compare section (if a report exists)
    const compareNode = this.buildCompareNode();
    if (compareNode) {
      nodes.push(compareNode);
    }

    nodes.push(this.buildDecisionsNode(this.state));
    nodes.push(this.buildClaimsNode(this.state));

    // Collapsed by default: Recent, Checks, Advanced
    const evidenceNode = this.buildEvidenceNode(this.state);
    if (evidenceNode) {
      nodes.push(evidenceNode);
    }

    const executionNode = this.buildExecutionNode(this.state);
    if (executionNode) {
      nodes.push(executionNode);
    }

    // Receipts section (audit trail)
    nodes.push(this.buildReceiptsNode());

    // Advanced section (collapsed)
    nodes.push(this.buildSessionNode(this.state));
    nodes.push(this.buildRegimeNode(this.state));

    // V7.1: Scope (between Regime and Stability)
    nodes.push(this.buildScopeNode());

    nodes.push(this.buildStabilityNode(this.state));

    // V7.1: Scars (after Stability)
    nodes.push(this.buildScarsNode());

    return nodes;
  }

  // -----------------------------------------------------------------------
  // V2 Builder methods
  // -----------------------------------------------------------------------

  buildSessionNode(s: GovernorViewModelV2): TreeNodeData {
    const children: TreeNodeData[] = [];

    if (s.session) {
      children.push({
        kind: "session-mode",
        label: `Mode: ${s.session.mode.toUpperCase()}`,
        collapsible: false,
        icon: s.session.mode === "strict" ? "lock" : "unlock",
      });
      children.push({
        kind: "session-authority",
        label: `Authority: ${s.session.authority_level}`,
        collapsible: false,
        icon: "shield",
      });
      if (s.session.jurisdiction) {
        children.push({
          kind: "session-jurisdiction",
          label: `Jurisdiction: ${s.session.jurisdiction.toUpperCase()}`,
          collapsible: false,
          icon: "globe",
        });
      }
      if (s.session.active_profile) {
        children.push({
          kind: "session-profile",
          label: `Profile: ${s.session.active_profile}`,
          collapsible: false,
          icon: "account",
        });
      }
      if (s.session.active_constraints.length > 0) {
        children.push({
          kind: "session-constraints",
          label: `Constraints: ${s.session.active_constraints.join(", ")}`,
          collapsible: false,
          icon: "list-filter",
        });
      }
    }

    return {
      kind: "session",
      label: "Governor Session",
      collapsible: true,
      icon: "pulse",
      children,
      detail: s.session ? JSON.stringify(s.session, null, 2) : undefined,
    };
  }

  buildRegimeNode(s: GovernorViewModelV2): TreeNodeData {
    const children: TreeNodeData[] = [];

    if (s.regime) {
      const regime = s.regime.name;
      children.push({
        kind: "regime",
        label: `Regime: ${regime.toUpperCase()}`,
        collapsible: false,
        icon: REGIME_ICONS[regime] ?? "shield",
      });

      if (s.regime.boil_mode) {
        children.push({
          kind: "boil",
          label: `Boil: ${s.regime.boil_mode.toUpperCase()}`,
          collapsible: false,
          icon: "beaker",
        });
      }

      const telemetryParts: string[] = [];
      for (const [key, val] of Object.entries(s.regime.telemetry)) {
        telemetryParts.push(`${key} ${val.toFixed(2)}`);
      }
      if (telemetryParts.length > 0) {
        children.push({
          kind: "telemetry",
          label: `Telemetry: ${telemetryParts.join(", ")}`,
          collapsible: false,
          icon: "graph-line",
        });
      }
    }

    return {
      kind: "regime-section",
      label: s.regime ? `Regime: ${s.regime.name.toUpperCase()}` : "Regime",
      collapsible: true,
      icon: s.regime ? (REGIME_ICONS[s.regime.name] ?? "shield") : "shield",
      children,
      detail: s.regime ? JSON.stringify(s.regime, null, 2) : undefined,
    };
  }

  buildDecisionsNode(s: GovernorViewModelV2): TreeNodeData {
    const children: TreeNodeData[] = s.decisions.map((d: DecisionView) => {
      // Human-friendly: show topic: choice, not ID
      const topic = (d.raw?.topic as string) ?? d.type;
      const choice = (d.raw?.choice as string) ?? "";
      const displayLabel = choice ? `${topic}: ${choice}` : topic;

      return {
        kind: "decision",
        label: displayLabel,
        description: d.rationale ? `"${d.rationale.slice(0, 40)}"` : undefined,
        collapsible: false,
        icon: "pin",  // More friendly than "law"
        detail: JSON.stringify(d, null, 2),
      };
    });

    // Human-friendly empty state
    if (children.length === 0) {
      children.push({
        kind: "decision-empty",
        label: "No decisions yet",
        description: "Add decisions to catch contradictions",
        collapsible: false,
        icon: "info",
      });
    }

    return {
      kind: "decisions",
      label: `Decisions (${s.decisions.length})`,
      collapsible: true,
      icon: "pin",
      children,
    };
  }

  buildClaimsNode(s: GovernorViewModelV2): TreeNodeData {
    const children: TreeNodeData[] = s.claims.map((c: ClaimView) => ({
      kind: "claim",
      label: `[${c.state.toUpperCase()}] ${c.content}`,
      description: `(${c.confidence.toFixed(2)})`,
      collapsible: false,
      icon: CLAIM_ICONS[c.state] ?? "question",
      detail: JSON.stringify(c, null, 2),
    }));

    return {
      kind: "claims",
      label: `Claims (${s.claims.length})`,
      collapsible: true,
      icon: "symbol-string",
      children,
    };
  }

  buildEvidenceNode(s: GovernorViewModelV2): TreeNodeData | null {
    if (s.evidence.length === 0) {
      return null;
    }

    const children: TreeNodeData[] = s.evidence.map((e: EvidenceView) => ({
      kind: "evidence",
      label: `[${e.type}] ${e.source || e.scope}`,
      description: `${e.linked_claims.length} claim(s)`,
      collapsible: false,
      icon: "file-symlink-file",
      detail: JSON.stringify(e, null, 2),
    }));

    return {
      kind: "evidence-section",
      label: `Evidence (${s.evidence.length})`,
      collapsible: true,
      icon: "file-symlink-file",
      children,
    };
  }

  buildViolationsNode(s: GovernorViewModelV2): TreeNodeData | null {
    // Rename to "Problems" for user-friendliness
    const children: TreeNodeData[] = s.violations.map((v: ViolationView) => ({
      kind: "violation",
      // Human-friendly: "You said X" framing
      label: v.rule_breached,
      description: v.detail ? v.detail.slice(0, 40) : undefined,
      collapsible: false,
      icon: VIOLATION_SEVERITY_ICONS[v.severity] ?? "warning",
      detail: JSON.stringify(v, null, 2),
    }));

    // Always show Problems section (even if empty)
    if (children.length === 0) {
      return {
        kind: "problems",
        label: "Problems (0)",
        description: "All good",
        collapsible: false,
        icon: "check",
        children: [],
      };
    }

    return {
      kind: "problems",
      label: `Problems (${s.violations.length})`,
      // Expand if there are problems
      collapsible: true,
      icon: "warning",
      children,
    };
  }

  buildExecutionNode(s: GovernorViewModelV2): TreeNodeData | null {
    if (!s.execution) {
      return null;
    }

    const ex = s.execution;
    const children: TreeNodeData[] = [];

    if (ex.pending.length > 0) {
      children.push({
        kind: "exec-pending",
        label: `Pending: ${ex.pending.length}`,
        collapsible: false,
        icon: "clock",
      });
    }
    if (ex.blocked.length > 0) {
      children.push({
        kind: "exec-blocked",
        label: `Blocked: ${ex.blocked.length}`,
        collapsible: false,
        icon: "close",
      });
    }
    if (ex.running.length > 0) {
      children.push({
        kind: "exec-running",
        label: `Running: ${ex.running.length}`,
        collapsible: false,
        icon: "sync~spin",
      });
    }
    if (ex.completed.length > 0) {
      children.push({
        kind: "exec-completed",
        label: `Completed: ${ex.completed.length}`,
        collapsible: false,
        icon: "check",
      });
    }

    return {
      kind: "execution",
      label: "Execution",
      collapsible: true,
      icon: "play",
      children,
      detail: JSON.stringify(ex, null, 2),
    };
  }

  buildStabilityNode(s: GovernorViewModelV2): TreeNodeData {
    const children: TreeNodeData[] = [];

    if (s.stability) {
      const st = s.stability;
      children.push({
        kind: "stability-rejection",
        label: `Rejection rate: ${st.rejection_rate.toFixed(2)}`,
        collapsible: false,
        icon: "graph-line",
      });
      children.push({
        kind: "stability-churn",
        label: `Claim churn: ${st.claim_churn.toFixed(2)}`,
        collapsible: false,
        icon: "graph-line",
      });
      children.push({
        kind: "stability-drift",
        label: `Drift: ${st.drift_alert}`,
        collapsible: false,
        icon: st.drift_alert === "NONE" ? "check" : "warning",
      });
    }

    return {
      kind: "stability",
      label: "Stability",
      collapsible: true,
      icon: "graph-line",
      children,
      detail: s.stability ? JSON.stringify(s.stability, null, 2) : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Gate Receipts section
  // -----------------------------------------------------------------------

  private static readonly VERDICT_ICONS: Record<string, string> = {
    pass: "check",
    warn: "warning",
    block: "error",
  };

  buildReceiptsNode(): TreeNodeData {
    const children: TreeNodeData[] = this.receipts.map((r: GateReceiptView) => ({
      kind: "receipt",
      label: `[${r.verdict.toUpperCase()}] ${r.gate}`,
      description: `${r.receipt_id.slice(0, 8)}… ${r.timestamp}`,
      collapsible: false,
      icon: GovernorTreeProvider.VERDICT_ICONS[r.verdict] ?? "question",
      detail: JSON.stringify(r, null, 2),
    }));

    if (children.length === 0) {
      children.push({
        kind: "receipt-empty",
        label: "No receipts yet",
        description: "Gate decisions will appear here",
        collapsible: false,
        icon: "info",
      });
    }

    return {
      kind: "receipts",
      label: `Receipts (${this.receipts.length})`,
      collapsible: true,
      icon: "output",
      children,
    };
  }

  // -----------------------------------------------------------------------
  // Code Autopilot: Intent section
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Code Interferometry: Compare section
  // -----------------------------------------------------------------------

  buildCompareNode(): TreeNodeData | null {
    if (!this.compareReport) {
      return null;
    }

    const report = this.compareReport;
    const markers = report.risk_marker_union || [];
    const conflicts = report.anchor_conflicts || [];
    const children: TreeNodeData[] = [];

    // Tier
    children.push({
      kind: "compare-tier",
      label: `Tier: ${report.tier}`,
      collapsible: false,
      icon: report.tier >= 1 ? "warning" : "check",
    });

    // Risk markers (union lens)
    if (markers.length > 0) {
      const markerChildren: TreeNodeData[] = markers.map((m) => ({
        kind: "compare-marker",
        label: `${m.marker_type}: ${m.message}`,
        description: `(${m.model_id})`,
        collapsible: false,
        icon: m.category === "security" ? "error" : "warning",
        tooltip: `${m.category} marker at ${m.file_path}:${m.line_number}`,
      }));

      children.push({
        kind: "compare-markers",
        label: `Markers (${markers.length})`,
        collapsible: true,
        icon: "list-unordered",
        children: markerChildren,
      });
    }

    // Anchor conflicts
    if (conflicts.length > 0) {
      const conflictChildren: TreeNodeData[] = conflicts.map((c) => ({
        kind: "compare-conflict",
        label: `${c.anchor_id} (${c.conflict_type})`,
        description: c.description.slice(0, 50),
        collapsible: false,
        icon: c.conflict_type === "hard" ? "error" : "warning",
      }));

      children.push({
        kind: "compare-conflicts",
        label: `Anchor Conflicts (${conflicts.length})`,
        collapsible: true,
        icon: "alert",
        children: conflictChildren,
      });
    }

    // Tier reasons
    if (report.tier_reasons && report.tier_reasons.length > 0) {
      for (const reason of report.tier_reasons) {
        children.push({
          kind: "compare-reason",
          label: reason,
          collapsible: false,
          icon: "info",
        });
      }
    }

    return {
      kind: "compare",
      label: `Compare (${markers.length} marker${markers.length !== 1 ? "s" : ""})`,
      collapsible: true,
      icon: "git-compare",
      children,
      detail: JSON.stringify(report, null, 2),
    };
  }

  buildIntentNode(): TreeNodeData {
    const children: TreeNodeData[] = [];

    if (this.intent) {
      const intent = this.intent.intent;
      const profile = intent.profile;
      const profileIcon = PROFILE_ICONS[profile] ?? "account";

      // Profile (with switch command)
      children.push({
        kind: "intent-profile",
        label: `Profile: ${profile.toUpperCase()}`,
        description: intent.source !== "default" ? `(${intent.source})` : undefined,
        collapsible: false,
        icon: profileIcon,
        tooltip: `Click to change profile`,
      });

      // Scope (if set)
      if (intent.scope && intent.scope.length > 0) {
        children.push({
          kind: "intent-scope",
          label: `Scope: ${intent.scope.join(", ")}`,
          collapsible: false,
          icon: "folder",
        });
      }

      // Deny (if set)
      if (intent.deny && intent.deny.length > 0) {
        children.push({
          kind: "intent-deny",
          label: `Deny: ${intent.deny.join(", ")}`,
          collapsible: false,
          icon: "circle-slash",
        });
      }

      // Timebox (if set)
      if (intent.expires_at) {
        const expires = new Date(intent.expires_at);
        const now = new Date();
        const remainingMs = expires.getTime() - now.getTime();
        const remainingMins = Math.max(0, Math.round(remainingMs / 60000));

        children.push({
          kind: "intent-timebox",
          label: `Timebox: ${remainingMins}m remaining`,
          collapsible: false,
          icon: "clock",
          tooltip: `Expires at ${expires.toLocaleTimeString()}`,
        });
      }

      // Reason (if set)
      if (intent.reason) {
        children.push({
          kind: "intent-reason",
          label: `Reason: ${intent.reason}`,
          collapsible: false,
          icon: "note",
        });
      }
    } else {
      // No intent set - show default
      children.push({
        kind: "intent-default",
        label: "Profile: ESTABLISHED (default)",
        description: "Click to change",
        collapsible: false,
        icon: "shield",
      });
    }

    // Active overrides (if any)
    if (this.overrides.length > 0) {
      const overrideChildren: TreeNodeData[] = this.overrides.map((o) => {
        const expires = new Date(o.expires_at);
        const now = new Date();
        const remainingMs = expires.getTime() - now.getTime();
        const remainingMins = Math.max(0, Math.round(remainingMs / 60000));

        return {
          kind: "override",
          label: `${o.anchor_id} (${remainingMins}m)`,
          description: o.scope.join(", "),
          tooltip: o.reason,
          collapsible: false,
          icon: "pass",
          detail: JSON.stringify(o, null, 2),
        };
      });

      children.push({
        kind: "overrides",
        label: `Overrides (${this.overrides.length})`,
        collapsible: true,
        icon: "pass",
        children: overrideChildren,
      });
    }

    const profile = this.intent?.intent.profile ?? "established";
    return {
      kind: "intent",
      label: `Intent: ${profile.toUpperCase()}`,
      description: this.intent?.intent.source !== "default" ? `(${this.intent?.intent.source})` : undefined,
      collapsible: true,
      icon: PROFILE_ICONS[profile] ?? "zap",
      children,
      detail: this.intent ? JSON.stringify(this.intent.intent, null, 2) : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // V7.1: Scope section
  // -----------------------------------------------------------------------

  buildScopeNode(): TreeNodeData {
    if (this.scopeStatus === null) {
      return {
        kind: "scope",
        label: "Scope",
        collapsible: false,
        icon: "compass",
        children: [{
          kind: "scope-unavailable",
          label: "Unavailable (upgrade governor)",
          collapsible: false,
          icon: "info",
        }],
      };
    }

    const s = this.scopeStatus;
    const children: TreeNodeData[] = [];

    // Axes summary
    const axes = Object.entries(s.run_scope);
    if (axes.length > 0) {
      const axisLabel = axes.map(([k, v]) => `${k}=${v}`).join(", ");
      children.push({
        kind: "scope-axes",
        label: `Axes: ${axisLabel}`,
        collapsible: false,
        icon: "list-flat",
      });
    } else {
      children.push({
        kind: "scope-axes",
        label: "No axes configured",
        description: "Run: governor scope set --axis key=value",
        collapsible: false,
        icon: "info",
      });
    }

    // Contracts count
    children.push({
      kind: "scope-contracts",
      label: `Contracts: ${s.contracts_count}`,
      collapsible: false,
      icon: "file-text",
    });

    // Grants (expandable)
    if (this.scopeGrants.length > 0) {
      const grantChildren: TreeNodeData[] = this.scopeGrants.map((g) => ({
        kind: "scope-grant",
        label: `${g.tool_id}`,
        description: `${g.usage_count} uses${g.write ? " [W]" : ""}${g.execute ? " [X]" : ""}`,
        collapsible: false,
        icon: g.write || g.execute ? "key" : "unlock",
        detail: JSON.stringify(g, null, 2),
      }));

      children.push({
        kind: "scope-grants",
        label: `Grants (${this.scopeGrants.length})`,
        collapsible: true,
        icon: "key",
        children: grantChildren,
      });
    }

    // Escalation stats
    if (s.escalation_count > 0) {
      children.push({
        kind: "scope-escalations",
        label: `Escalations: ${s.escalation_count}`,
        collapsible: false,
        icon: "arrow-up",
      });
    }

    // Section label
    const scopeLabel = axes.length > 0
      ? `Scope: ${axes[0][1].toUpperCase()}${axes.length > 1 ? ` +${axes.length - 1}` : ""}`
      : "Scope: not configured";

    return {
      kind: "scope",
      label: scopeLabel,
      collapsible: true,
      icon: "compass",
      children,
      detail: JSON.stringify({ status: s, grants: this.scopeGrants }, null, 2),
    };
  }

  // -----------------------------------------------------------------------
  // V7.1: Scars section
  // -----------------------------------------------------------------------

  buildScarsNode(): TreeNodeData {
    if (this.scarResult === null) {
      return {
        kind: "scars",
        label: "Scars",
        collapsible: false,
        icon: "shield",
        children: [{
          kind: "scars-unavailable",
          label: "Unavailable (upgrade governor)",
          collapsible: false,
          icon: "info",
        }],
      };
    }

    const { scars, shields, stats } = this.scarResult;
    const children: TreeNodeData[] = [];

    // Scars group
    if (scars.length > 0) {
      const scarChildren: TreeNodeData[] = scars.map((s) => ({
        kind: "scar-item",
        label: `${s.region}${s.is_hard ? " [HARD]" : ""}`,
        description: stiffnessBar(s.stiffness),
        collapsible: false,
        icon: s.is_hard ? "warning" : "info",
        tooltip: `Stiffness: ${s.stiffness.toFixed(3)} | Evidence: ${s.evidence_count}/${s.required_evidence} | ${s.provenance}`,
        detail: JSON.stringify(s, null, 2),
      }));

      children.push({
        kind: "scars-group",
        label: `Scars (${scars.length})`,
        collapsible: true,
        icon: "warning",
        children: scarChildren,
      });
    }

    // Shields group
    if (shields.length > 0) {
      const shieldChildren: TreeNodeData[] = shields.map((s) => ({
        kind: "shield-item",
        label: `${s.source}`,
        description: s.is_fully_blocked ? "BLOCKED" : `${Math.round(s.permeability * 100)}% open`,
        collapsible: false,
        icon: s.is_fully_blocked ? "error" : "info",
        tooltip: `Stable cycles: ${s.stable_cycles_observed}/${s.stable_cycles_required}`,
        detail: JSON.stringify(s, null, 2),
      }));

      children.push({
        kind: "shields-group",
        label: `Shields (${shields.length})`,
        collapsible: true,
        icon: "shield",
        children: shieldChildren,
      });
    }

    // History group (collapsed, max 10)
    if (this.scarHistory.length > 0) {
      const historyChildren: TreeNodeData[] = this.scarHistory.slice(0, 10).map((e) => ({
        kind: "scar-history-item",
        label: `${e.region} (${e.provenance})`,
        description: `rho=${e.surprise_ratio.toFixed(2)} ${e.response_type}`,
        collapsible: false,
        icon: "history",
        detail: JSON.stringify(e, null, 2),
      }));

      children.push({
        kind: "scars-history",
        label: `History (${Math.min(this.scarHistory.length, 10)})`,
        collapsible: true,
        icon: "history",
        children: historyChildren,
      });
    }

    // Empty state
    if (scars.length === 0 && shields.length === 0) {
      children.push({
        kind: "scars-empty",
        label: "No scars or shields",
        collapsible: false,
        icon: "check",
      });
    }

    // Health-colored icon
    const healthIcon = stats.health === "CONSTRAINED" ? "warning"
      : stats.health === "CAUTIOUS" ? "info"
      : "check";

    const parts: string[] = [];
    if (stats.total_scars > 0) { parts.push(`${stats.total_scars} scar${stats.total_scars !== 1 ? "s" : ""}`); }
    if (stats.total_shields > 0) { parts.push(`${stats.total_shields} shield${stats.total_shields !== 1 ? "s" : ""}`); }
    const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";

    return {
      kind: "scars",
      label: `Scars: ${stats.health}${summary}`,
      collapsible: true,
      icon: healthIcon,
      children,
      detail: JSON.stringify(this.scarResult, null, 2),
    };
  }
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * 5-char stiffness bar using Unicode block characters.
 * Clamp hard: null/undefined/NaN/out-of-range → safe.
 */
export function stiffnessBar(n: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const filled = Math.round(clamped * 5);
  return "\u2588".repeat(filled) + "\u2591".repeat(5 - filled);
}
