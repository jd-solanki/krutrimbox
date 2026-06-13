#!/usr/bin/env node

import { Command } from "commander";
import updateNotifier from "update-notifier";
import packageJson from "../package.json" with { type: "json" };
import { createRunCommand, type CliDispatch } from "./commands/run";

export type { CliDispatch } from "./commands/run";

export function createProgram(dispatch?: CliDispatch): Command {
  const program = new Command();

  program
    .name("kb")
    .description("Run krutrimbox orchestration for ready PRDs.")
    .version(packageJson.version);

  program.addCommand(createRunCommand(dispatch));

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // notify() defers its message to process exit, so registering it before
  // parseAsync guarantees the listener is in place no matter which command runs.
  updateNotifier({ pkg: packageJson }).notify();

  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
