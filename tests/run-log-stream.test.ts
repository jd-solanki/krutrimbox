import { describe, expect, test } from "vitest";
import { Writable } from "node:stream";
import { RunLogStream } from "../src/lib/factory/run-log-stream";
import type { RunLogCodec } from "../src/lib/factory/index";

// A codec stand-in that upper-cases each line and drops any line containing
// "noise" — enough to prove the stream splits, renders, and skips, without
// coupling these tests to Claude's real event shapes.
const fakeCodec: RunLogCodec = {
  renderLine: (line) => (line.includes("noise") ? null : line.toUpperCase()),
  extractResultText: (stdout) => stdout
};

// Captures what reaches the destination and whether anyone closed it.
function captureDestination() {
  const writes: string[] = [];
  let ended = false;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
    final(callback) {
      ended = true;
      callback();
    }
  });
  return {
    stream,
    text: () => writes.join(""),
    wasEnded: () => ended
  };
}

describe("RunLogStream", () => {
  test("renders each complete line through the codec to the destination", () => {
    const destination = captureDestination();
    const log = new RunLogStream(fakeCodec, destination.stream);

    log.write("hello\nworld\n");

    expect(destination.text()).toBe("HELLO\nWORLD\n");
  });

  test("reassembles a line split across chunk boundaries", () => {
    const destination = captureDestination();
    const log = new RunLogStream(fakeCodec, destination.stream);

    log.write("par");
    log.write("tial\n");

    expect(destination.text()).toBe("PARTIAL\n");
  });

  test("drops lines the codec suppresses", () => {
    const destination = captureDestination();
    const log = new RunLogStream(fakeCodec, destination.stream);

    log.write("keep\nthis is noise\nkeep2\n");

    expect(destination.text()).toBe("KEEP\nKEEP2\n");
  });

  test("flush emits a trailing line that arrived without a newline", () => {
    const destination = captureDestination();
    const log = new RunLogStream(fakeCodec, destination.stream);

    log.write("no trailing newline");
    log.flush();

    expect(destination.text()).toBe("NO TRAILING NEWLINE\n");
  });

  test("never closes the destination, which outlives one agent run", () => {
    const destination = captureDestination();
    const log = new RunLogStream(fakeCodec, destination.stream);

    log.write("line\n");
    log.flush();

    expect(destination.wasEnded()).toBe(false);
  });
});
