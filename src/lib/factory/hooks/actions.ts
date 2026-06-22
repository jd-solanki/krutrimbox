import type { Hookable } from "hookable";
import { diagnostics } from "../../diagnostics";
import { interpolate, type InterpolationValues } from "../../../utils/interpolate";
import type { ResolvedHookAction } from "../config";
import type { KrutrimboxHookName } from "./names";
import type { HookActionDependencies, HookContext, KrutrimboxHooks } from "./types";

// Registers each configured action as a handler on its hook, in order. `callHook`
// then runs them sequentially and rejects on the first failure — exactly the
// fail-fast behavior krutrimbox wants (ADR-0021). Each handler closes over a
// precomputed label so a failure names the offending action, and over a shared
// runner so every action sees the deps without threading them through.
export function registerHookActions(
  hooks: Hookable<KrutrimboxHooks>,
  hookName: KrutrimboxHookName,
  actions: ResolvedHookAction[],
  deps: HookActionDependencies
): void {
  const runner = new HookActionRunner(deps);

  actions.forEach((action, index) => {
    const label = describeAction(action, index);
    hooks.hook(hookName, async (context) => {
      try {
        await runner.run(action, context);
      } catch (error) {
        throw diagnostics.KB_R0008({
          hook: hookName,
          action: label,
          detail: error instanceof Error ? error.message : String(error),
          cause: error
        });
      }
    });
  });
}

// Executes a single Hook Action against the shared HookContext. Holding the deps
// as a field keeps every action method to its own concern's arguments.
class HookActionRunner {
  public constructor(private readonly deps: HookActionDependencies) {}

  public async run(action: ResolvedHookAction, context: HookContext): Promise<void> {
    const values = { ...context.variables, ...asActionOutputValues(context.outputs) };

    switch (action.kind) {
      case "comment":
        return this.postComment(context.pullRequestNumber, interpolate(action.body, values));
      case "command":
        return this.runCommand(action.run, values);
      case "agent": {
        const output = await this.runAgentAction(action, context, values);
        if (action.id) {
          context.outputs.set(action.id, output);
        }
        return;
      }
    }
  }

  private async postComment(pullRequestNumber: number, body: string): Promise<void> {
    await this.deps.github.createIssueComment(pullRequestNumber, body);
    this.deps.logger.log(
      `krutrimbox: posted hook comment on Target Issue Pull Request #${pullRequestNumber}.`
    );
  }

  private async runCommand(run: string[], values: InterpolationValues): Promise<void> {
    const [command, ...args] = run.map((part) => interpolate(part, values));
    await this.deps.runHostCommand(command, args);
    this.deps.logger.log(`krutrimbox: ran hook command: ${[command, ...args].join(" ")}.`);
  }

  // Runs one Agent Action's session, then commits any code it changed (ADR-0021):
  // the sandbox holds a read-only token, so the host performs the commit. The
  // session's text is returned for capture as an Action Output.
  private async runAgentAction(
    action: Extract<ResolvedHookAction, { kind: "agent" }>,
    context: HookContext,
    values: InterpolationValues
  ): Promise<string> {
    const prompt = interpolate(action.prompt, values);
    const output = await this.deps.sandbox.runAgentSession({
      sandboxName: context.sandboxName,
      prompt,
      output: this.deps.output
    });

    await this.commitAgentChanges(action, context, prompt);
    return output;
  }

  private async commitAgentChanges(
    action: Extract<ResolvedHookAction, { kind: "agent" }>,
    context: HookContext,
    prompt: string
  ): Promise<void> {
    const hasChanges = await this.deps.sandbox.hasWorkingTreeChanges({
      sandboxName: context.sandboxName
    });

    if (!hasChanges) {
      return;
    }

    await this.deps.sandbox.commitReviewChanges({
      sandboxName: context.sandboxName,
      branchName: context.branchName,
      subject: `chore: ${describeAgentAction(action)} changes`,
      body: prompt
    });
    this.deps.logger.log(`krutrimbox: committed ${describeAgentAction(action)} changes.`);
  }
}

// Projects the Action Output map onto the `{{steps.<id>.output}}` interpolation
// keys later actions reference.
function asActionOutputValues(outputs: Map<string, string>): InterpolationValues {
  const values: InterpolationValues = {};
  for (const [id, output] of outputs) {
    values[`steps.${id}.output`] = output;
  }
  return values;
}

// Names an action for fail-fast diagnostics: an Agent Action by its id when
// present, every action otherwise by its 1-based position in the hook.
function describeAction(action: ResolvedHookAction, index: number): string {
  if (action.kind === "agent" && action.id) {
    return `agent action "${action.id}"`;
  }
  return `${action.kind} action #${index + 1}`;
}

function describeAgentAction(action: Extract<ResolvedHookAction, { kind: "agent" }>): string {
  return action.id ? `agent action "${action.id}"` : "agent action";
}
