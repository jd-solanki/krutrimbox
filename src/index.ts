#!/usr/bin/env node

import { Command } from "commander";
import { Diagnostic, formatDiagnostic } from "nostics";
import updateNotifier from "update-notifier";
import packageJson from "../package.json" with { type: "json" };
import { createRunCommand } from "./commands/run";

// notify() defers its message to process exit, so registering it before
// parseAsync guarantees the listener is in place no matter which command runs.
updateNotifier({ pkg: packageJson }).notify();

const program = new Command();

program
  .name("kb")
  .description("Run krutrimbox orchestration for ready Target Issues.")
  .version(packageJson.version);

program.addCommand(createRunCommand());

// Diagnostics krutrimbox raises itself (the `KB_*` catalog in lib/diagnostics)
// carry a `fix` and a `docs` URL beyond their message; render those on the way
// out so the operator sees the actionable detail instead of a raw stack. Any
// other failure rethrows unchanged, preserving its stack for debugging.
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof Diagnostic) {
    console.error(formatDiagnostic(error));
    process.exit(1);
  }
  // An uncoded error reached the top: by krutrimbox's Expected/Unexpected split
  // this is a likely bug. Point the operator at the issue tracker, then rethrow so
  // the stack still prints for debugging and the exit code stays non-zero.
  console.error(
    `\nkrutrimbox hit an unexpected error (likely a bug). Please report it at ${packageJson.bugs.url} with the steps to reproduce.`
  );
  throw error;
}
