import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { deterministicPrdSandbox } from "./sequence.js";

// A per-PRD log sink for one Factory Run. Status lines (`log`) are tee'd to the
// terminal and the file so a run stays visible while it happens; the raw
// sandbox/agent bytes are piped through `stream` into the file only, keeping the
// terminal clean. `close` flushes and closes the file once the run finishes.
export interface RunLog {
  readonly stream: NodeJS.WritableStream;
  readonly filePath: string | null;
  log(message: string): void;
  close(): Promise<void>;
}

// Builds the RunLog for a given PRD. Injected into CodeFactory so tests can swap
// in a silent sink instead of touching the filesystem.
export type RunLogFactory = (prdNumber: number) => RunLog;

// Production factory: each run writes to
// `.code-factory/logs/code-factory-prd-<num>--<stamp>.log`, appending so a
// retried run extends its file rather than truncating. Status lines are also
// forwarded to `terminal` so progress still shows while noise stays in the file.
export function createFileRunLogFactory(
  cwd: string,
  terminal: Pick<Console, "log"> = console
): RunLogFactory {
  return (prdNumber) => {
    const dir = path.join(cwd, ".code-factory", "logs");
    mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${deterministicPrdSandbox(prdNumber)}--${timestamp()}.log`);
    const stream = createWriteStream(filePath, { flags: "a" });
    stream.on("error", (error) => terminal.log(`Code Factory: log file ${filePath} error: ${String(error)}`));

    return {
      stream,
      filePath,
      log(message) {
        terminal.log(message);
        stream.write(`${message}\n`);
      },
      close() {
        return new Promise((resolve) => stream.end(() => resolve()));
      }
    };
  };
}

// Filesystem-safe instant with millisecond precision, e.g. 2026-06-12_10-20-30-123.
// The `:` separators and the fractional `.` are replaced so the filename is
// portable across operating systems.
function timestamp(): string {
  return new Date()
    .toISOString()
    .replace("T", "_")
    .replaceAll(":", "-")
    .replace(".", "-")
    .replace("Z", "");
}
