#!/usr/bin/env node

import { Command, Option } from "commander";
import { runCodeFactory } from "./factory/index.js";

export interface CliDispatch {
  runExplicit(prdNumber: number): Promise<void> | void;
  runBatch(): Promise<void> | void;
}

export function createProgram(dispatch: CliDispatch = runCodeFactory): Command {
  const program = new Command();

  program
    .name("code-factory")
    .description("Run Code Factory orchestration for ready PRDs.");

  program
    .command("run")
    .description("Run Code Factory for one PRD or all ready PRDs.")
    .addOption(
      new Option("--prd <number>", "run one explicit PRD by issue number").argParser(
        parsePrdNumber
      )
    )
    .action(async (options: { prd?: number }) => {
      if (typeof options.prd === "number") {
        await dispatch.runExplicit(options.prd);
        return;
      }

      await dispatch.runBatch();
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

function parsePrdNumber(value: string): number {
  const prdNumber = Number(value);

  if (!Number.isInteger(prdNumber) || prdNumber < 1) {
    throw new Error("PRD number must be a positive integer.");
  }

  return prdNumber;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
