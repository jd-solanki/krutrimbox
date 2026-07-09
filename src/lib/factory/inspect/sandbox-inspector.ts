import { AGENT_NAMES, type AgentName } from "../agents/coding-agent";
import { TARGET_ISSUE_SANDBOX_PREFIX } from "../constants";
import { diagnostics } from "../../diagnostics";
import type { CommandRunner } from "../../github";
import { parseSandboxList } from "../sandbox-runner";

// The coarse condition Sandbox Inspection reports for a Target Issue Sandbox.
// BUSY: the Sandboxed Agent's subtree burned CPU between the two samples (or is
// awaiting the model with no sub-command). STALLED: a sub-command is running but
// the subtree made no CPU progress across the samples. EXITED: no Sandboxed Agent
// process — the run crashed or finished.
export type SandboxVerdict = "busy" | "stalled" | "exited";

// Whether a Factory Run is driving the sandbox. LIVE: a Sandboxed Agent process is
// running — the ground-truth signal that work is in flight. When no agent runs, the
// Target Issue Lock tells crashed from clean: STALE (lock still held — a crashed or
// between-sessions run) versus LEFT-BEHIND (no lock — a paused or failed run kept
// for inspection).
export type SandboxLiveness = "live" | "stale" | "left-behind";

// A Sandbox Inspection's finding for one resolved Target Issue Sandbox.
export interface SandboxStatusReport {
  issueNumber: number;
  agent: AgentName;
  sandboxName: string;
  liveness: SandboxLiveness;
  verdict: SandboxVerdict;
  // Whether `sbx exec` could reach the sandbox at all. False means the sandbox is
  // present in `sbx ls` but stopped, so nothing inside it could be read — a
  // different EXITED story from an agent that crashed inside a running sandbox.
  execReachable: boolean;
  // The sub-command the Sandboxed Agent is running right now (its busiest
  // descendant), or null when only the agent process is present (thinking /
  // awaiting the model) or none is (EXITED).
  activeCommand: string | null;
  // The sandbox clone's branch and how many files it has changed, or null when the
  // sandbox is stopped so its git state cannot be read.
  work: { branch: string; changedFiles: number } | null;
  // Recent `sbx policy log` output, captured only for a STALLED verdict where a
  // network DENY is the likeliest cause. Attached as evidence, never interpreted.
  policyLog: string | null;
  // The tail of this issue's newest host run log, shown only for STALLED/EXITED
  // where the agent is not mid-tool-call (a busy run's log tail looks frozen
  // because krutrimbox flushes a log line only when a tool call completes).
  hostLogTail: string | null;
}

// The result of a Sandbox Inspection request: a report for the one resolved
// sandbox, or no sandbox for that issue (an informative, non-error state).
export type InspectOutcome =
  | { kind: "reported"; report: SandboxStatusReport }
  | { kind: "no-sandbox"; issueNumber: number; agent?: AgentName };

export interface InspectRequest {
  issueNumber: number;
  // When set, narrows to the sandbox built by this Agent Backend; required only to
  // break the tie when the same issue was run under both backends.
  agent?: AgentName;
}

export interface SandboxInspectorDeps {
  // The one boundary to `sbx`. Faked in tests by switching on the args.
  runner: CommandRunner;
  // Read-only Target Issue Lock probe — the Sandbox Liveness signal.
  isIssueLocked: (issueNumber: number) => Promise<boolean>;
  // The tail of this issue's newest host run log, or null when there is none.
  readHostLogTail: (issueNumber: number) => Promise<string | null>;
  // The wait between the two process samples. Injected so tests need not sleep.
  sleep: (ms: number) => Promise<void>;
  // The absolute repository path passed to `sbx exec --workdir` (the Sandbox
  // Workspace Path), where the sandbox exposes its clone for git reads.
  workspacePath: string;
}

// The gap between the two process-tree samples the BUSY-vs-STALLED verdict rests
// on. Long enough for a working sub-command to accrue measurable CPU time, short
// enough to stay interactive.
const SAMPLE_INTERVAL_MS = 2000;

// Reads a live Target Issue Sandbox's state through `sbx` and reports what the
// Sandboxed Agent is doing — read-only, offline, and never mutating the sandbox,
// the issue, or GitHub (ADR-0025). Kept separate from CommandSandboxRunner, which
// owns the mutating run lifecycle; the two share only the `sbx` CommandRunner seam.
export class SandboxInspector {
  public constructor(private readonly deps: SandboxInspectorDeps) {}

  public async inspect(request: InspectRequest): Promise<InspectOutcome> {
    const resolution = await this.resolveSandbox(request);
    if (!resolution) {
      return { kind: "no-sandbox", issueNumber: request.issueNumber, agent: request.agent };
    }

    const report = await this.inspectResolved(request.issueNumber, resolution);
    return { kind: "reported", report };
  }

  // Finds the one Target Issue Sandbox for this request by scanning `sbx ls` for
  // the slug-independent `krutrimbox-issue-<n>-…-<agent>` shape — no repository
  // slug, no `gh`, no network. Returns null when none matches; throws KB_R0014
  // when several agents match and the request did not name one.
  private async resolveSandbox(
    request: InspectRequest
  ): Promise<{ sandboxName: string; agent: AgentName } | null> {
    const listing = await this.listSandboxes();
    const matches = matchTargetIssueSandboxes(listing, request.issueNumber).filter(
      (match) => !request.agent || match.agent === request.agent
    );

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      throw diagnostics.KB_R0014({
        issueNumber: request.issueNumber,
        agents: matches.map((match) => match.agent).join(", ")
      });
    }

    return matches[0];
  }

  private async inspectResolved(
    issueNumber: number,
    resolved: { sandboxName: string; agent: AgentName }
  ): Promise<SandboxStatusReport> {
    const first = await this.sampleProcesses(resolved.sandboxName);
    await this.deps.sleep(SAMPLE_INTERVAL_MS);
    const second = await this.sampleProcesses(resolved.sandboxName);

    // A stopped sandbox fails every `sbx exec`, so a null sample means unreachable
    // rather than "no processes"; the verdict then reads from empty snapshots.
    const execReachable = first !== null || second !== null;
    const judgement = judgeProcessSamples(first ?? [], second ?? [], resolved.agent);
    const liveness = await this.deriveLiveness(issueNumber, judgement.agentPresent);

    const stalledOrExited = judgement.verdict !== "busy";
    return {
      issueNumber,
      agent: resolved.agent,
      sandboxName: resolved.sandboxName,
      liveness,
      verdict: judgement.verdict,
      execReachable,
      activeCommand: judgement.activeCommand,
      work: await this.readWork(resolved.sandboxName),
      policyLog: judgement.verdict === "stalled" ? await this.readPolicyLog() : null,
      hostLogTail: stalledOrExited ? await this.deps.readHostLogTail(issueNumber) : null
    };
  }

  private async deriveLiveness(
    issueNumber: number,
    agentPresent: boolean
  ): Promise<SandboxLiveness> {
    if (agentPresent) {
      return "live";
    }
    return (await this.deps.isIssueLocked(issueNumber)) ? "stale" : "left-behind";
  }

  // One process-tree snapshot from inside the sandbox. `time` is cumulative CPU
  // time (the progress signal), not `%CPU` (a lifetime average that barely moves
  // over two seconds). Returns null when `sbx exec` fails — a stopped, unreachable
  // sandbox — which the caller reports as EXITED rather than treating as an error.
  private async sampleProcesses(sandboxName: string): Promise<ProcessLine[] | null> {
    try {
      const output = await this.exec(sandboxName, ["ps", "-eo", "pid,ppid,stat,time,args"]);
      return parseProcessSnapshot(output);
    } catch {
      return null;
    }
  }

  private async readWork(sandboxName: string): Promise<{ branch: string; changedFiles: number } | null> {
    try {
      const status = await this.exec(sandboxName, ["git", "status", "--short", "--branch"]);
      return parseGitStatus(status);
    } catch {
      return null;
    }
  }

  private async readPolicyLog(): Promise<string | null> {
    try {
      const log = (await this.deps.runner("sbx", ["policy", "log"])).trim();
      return log.length > 0 ? log : null;
    } catch {
      return null;
    }
  }

  private async listSandboxes(): Promise<string[]> {
    try {
      const output = await this.deps.runner("sbx", ["ls", "--json"]);
      return parseSandboxList(output).sandboxes.map((sandbox) => sandbox.name);
    } catch (error) {
      throw diagnostics.KB_R0015({ cause: error });
    }
  }

  private exec(sandboxName: string, command: string[]): Promise<string> {
    return this.deps.runner("sbx", [
      "exec",
      "--workdir",
      this.deps.workspacePath,
      sandboxName,
      "--",
      ...command
    ]);
  }
}

// A parsed `ps -eo pid,ppid,stat,time,args` row.
export interface ProcessLine {
  pid: number;
  ppid: number;
  stat: string;
  cpuSeconds: number;
  args: string;
}

// The verdict plus what fed it, kept together so callers need not re-walk the tree.
interface ProcessJudgement {
  verdict: SandboxVerdict;
  agentPresent: boolean;
  activeCommand: string | null;
}

// Splits an `sbx ls` name listing into the Target Issue Sandboxes for one issue,
// tagged by Agent Backend. The match is on the fixed name shape
// `krutrimbox-issue-<n>-…-<agent>`; the trailing `-` after the number keeps issue
// 1 from matching issue 15, and the `-<agent>` suffix names the backend.
export function matchTargetIssueSandboxes(
  names: string[],
  issueNumber: number
): Array<{ sandboxName: string; agent: AgentName }> {
  const prefix = `${TARGET_ISSUE_SANDBOX_PREFIX}${issueNumber}-`;

  return names.flatMap((name) => {
    if (!name.startsWith(prefix)) {
      return [];
    }
    const agent = AGENT_NAMES.find((candidate) => name.endsWith(`-${candidate}`));
    return agent ? [{ sandboxName: name, agent }] : [];
  });
}

// Parses a `ps -eo pid,ppid,stat,time,args` capture, dropping the header row. Each
// row splits into four fixed fields and a trailing free-form `args`, so a command
// with embedded spaces stays intact.
export function parseProcessSnapshot(output: string): ProcessLine[] {
  const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/;

  return output
    .split("\n")
    .map((line) => rowPattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
      cpuSeconds: parseCpuTime(match[4]),
      args: match[5].trim()
    }));
}

// Turns a `ps` cumulative CPU time field — `[DD-]HH:MM:SS` or `MM:SS` — into
// seconds. Returns 0 for the header's non-numeric `TIME`, which the row pattern
// already filters out anyway.
function parseCpuTime(field: string): number {
  const [daysPart, clockPart] = field.includes("-") ? field.split("-") : ["0", field];
  const segments = clockPart.split(":").map(Number);
  if (segments.some((segment) => Number.isNaN(segment))) {
    return 0;
  }

  const seconds = segments.reduce((total, segment) => total * 60 + segment, 0);
  return Number(daysPart) * 86_400 + seconds;
}

// The BUSY/STALLED/EXITED verdict from two process samples taken moments apart.
// Absent Sandboxed Agent → EXITED. Otherwise the agent's whole subtree is the
// evidence, and progress is any of two things across the samples: a process that
// survived both samples burned more CPU time, or a new sub-command was spawned
// (the agent kicked off fresh work) → BUSY. Only when neither happened and a
// sub-command is still running is that command pinned → STALLED. With no
// sub-command at all, the agent is between tool calls or awaiting the model → BUSY.
//
// Comparing *surviving* pids rather than the subtree's CPU total is what makes
// churn read correctly: when one child finishes and another starts, its CPU leaves
// the total, so a naive sum could fall and look stalled even though work continued.
// Distinguishing a truly wedged bare agent from a thinking one is the fuzzy
// judgment krutrimbox declines to guess (ADR-0025).
export function judgeProcessSamples(
  first: ProcessLine[],
  second: ProcessLine[],
  agent: AgentName
): ProcessJudgement {
  const agentProcess = findAgentProcess(second, agent);
  if (!agentProcess) {
    return { verdict: "exited", agentPresent: false, activeCommand: null };
  }

  const before = new Map(
    subtreeOf(first, findAgentProcess(first, agent)?.pid).map((proc) => [proc.pid, proc.cpuSeconds])
  );
  const after = subtreeOf(second, agentProcess.pid);

  const anySurvivorProgressed = after.some(
    (proc) => before.has(proc.pid) && proc.cpuSeconds > before.get(proc.pid)!
  );
  const anyNewSubCommand = after.some((proc) => proc.pid !== agentProcess.pid && !before.has(proc.pid));

  const activeChild = busiestDescendant(second, agentProcess.pid);
  const activeCommand = activeChild ? activeChild.args : null;

  if (anySurvivorProgressed || anyNewSubCommand) {
    return { verdict: "busy", agentPresent: true, activeCommand };
  }
  if (activeChild) {
    return { verdict: "stalled", agentPresent: true, activeCommand };
  }
  return { verdict: "busy", agentPresent: true, activeCommand: null };
}

// The Sandboxed Agent's own process: the row whose command is the backend binary
// (`claude` / `codex`), as argv[0] or its basename — never a descendant that
// merely mentions the name in its arguments.
function findAgentProcess(processes: ProcessLine[], agent: AgentName): ProcessLine | undefined {
  return processes.find((proc) => {
    const command = proc.args.split(/\s+/)[0] ?? "";
    const binary = command.slice(command.lastIndexOf("/") + 1);
    return binary === agent;
  });
}

// The agent process and every descendant — the whole subtree, so a child
// build/install/test session is inspected alongside the agent. Empty when the
// agent is absent (no root).
function subtreeOf(processes: ProcessLine[], rootPid: number | undefined): ProcessLine[] {
  return rootPid === undefined ? [] : descendantsOf(processes, rootPid);
}

// The descendant sub-command doing the most work — what the agent is running right
// now — excluding the agent process itself. Undefined when the agent has no
// children (between tool calls or awaiting the model).
function busiestDescendant(processes: ProcessLine[], agentPid: number): ProcessLine | undefined {
  return descendantsOf(processes, agentPid)
    .filter((proc) => proc.pid !== agentPid)
    .sort((left, right) => right.cpuSeconds - left.cpuSeconds)[0];
}

// The root process and all processes reachable from it through the ppid chain.
function descendantsOf(processes: ProcessLine[], rootPid: number): ProcessLine[] {
  const childrenByParent = new Map<number, ProcessLine[]>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push(proc);
    childrenByParent.set(proc.ppid, siblings);
  }

  const collected: ProcessLine[] = [];
  const frontier = [rootPid];
  const seen = new Set<number>();
  while (frontier.length > 0) {
    const pid = frontier.pop()!;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);

    const self = processes.find((proc) => proc.pid === pid);
    if (self) {
      collected.push(self);
    }
    for (const child of childrenByParent.get(pid) ?? []) {
      frontier.push(child.pid);
    }
  }

  return collected;
}

// Reads the sandbox clone's branch and changed-file count from a
// `git status --short --branch` capture. The `## <branch>...<upstream>` header
// names the branch; every other line is one changed path.
export function parseGitStatus(output: string): { branch: string; changedFiles: number } {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branch = branchLine
    ? branchLine.slice(3).split(/\.{3}|\s/)[0]
    : "(unknown)";
  const changedFiles = lines.filter((line) => !line.startsWith("## ")).length;

  return { branch, changedFiles };
}
