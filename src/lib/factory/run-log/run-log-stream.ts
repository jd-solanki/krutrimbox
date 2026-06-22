import { Writable } from "node:stream";
import type { RunLogCodec } from "../agents/coding-agent";

// A write-through stream that turns an Agent Backend's raw, line-delimited output
// into readable run-log lines as it streams. It sits between the sandbox exec and
// the run-log file: the exec writes raw bytes here, and each complete line is
// handed to the agent's `RunLogCodec` and the rendered result forwarded on.
//
// Why line buffering: exec output arrives in arbitrary chunks that rarely align
// to line boundaries, and the codec decodes one event per line. Buffering until a
// newline also keeps a half-written event from interleaving mid-line with the
// status messages that share the same run-log file.
//
// This stream deliberately never ends its destination. One run-log file is shared
// across every agent run of a Factory Run (and the run's status lines); only the
// run owns closing it. A fresh RunLogStream wraps that file per agent run and is
// discarded after `flush`.
export class RunLogStream extends Writable {
  private pending = "";

  public constructor(
    private readonly codec: RunLogCodec,
    private readonly destination: NodeJS.WritableStream
  ) {
    super();
  }

  // Emits any buffered text that arrived without a closing newline. Call once the
  // agent exec has finished, so a final unterminated line is not lost.
  public flush(): void {
    if (this.pending.length > 0) {
      this.renderLine(this.pending);
      this.pending = "";
    }
  }

  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.pending += chunk.toString();

    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex !== -1) {
      this.renderLine(this.pending.slice(0, newlineIndex));
      this.pending = this.pending.slice(newlineIndex + 1);
      newlineIndex = this.pending.indexOf("\n");
    }

    callback();
  }

  private renderLine(line: string): void {
    const rendered = this.codec.renderLine(line);
    if (rendered !== null) {
      this.destination.write(`${rendered}\n`);
    }
  }
}
