#!/usr/bin/env node

import { Command } from "commander";
import updateNotifier from "update-notifier";
import packageJson from "../package.json" with { type: "json" };
import { createRunCommand } from "./commands/run";

// notify() defers its message to process exit, so registering it before
// parseAsync guarantees the listener is in place no matter which command runs.
updateNotifier({ pkg: packageJson }).notify();

const program = new Command();

program
  .name("kb")
  .description("Run krutrimbox orchestration for ready PRDs.")
  .version(packageJson.version);

program.addCommand(createRunCommand());

await program.parseAsync();
