import type { RunLogCodec } from "./coding-agent";

// Decodes the Claude Agent Backend's `--output-format stream-json` output, which
// is one standalone JSON event per line (newline-delimited). Claude only streams
// its session live in this format; the default `text` format buffers the whole
// turn and prints once at the end, leaving the run log empty until completion.
//
// This codec is the seam that keeps that machine-readable stream from leaking
// into human-facing surfaces: `renderLine` turns each event into a readable
// run-log line, and `extractResultText` lifts the final assistant message out for
// the review body, instead of the whole JSONL wall reaching the PR comment.

// The review body shown when a finished session carried no terminal result text.
// Defensive only: a non-zero exit rejects in the command runner before extraction
// runs, so a successful run always carries a result event in practice.
const NO_RESULT_FALLBACK = "krutrimbox: the agent produced no review summary.";

// How much of a tool result is kept in the run log. Tool output is often hundreds
// of lines; a one-line preview shows the request/response rhythm without the wall.
const TOOL_RESULT_PREVIEW_LENGTH = 100;

export const claudeRunLogCodec: RunLogCodec = {
  renderLine(line: string): string | null {
    const event = tryParseEvent(line);

    // Not a recognized event line (e.g. interleaved stderr): log it untouched so
    // a real message — often an error — is never swallowed.
    if (!event) {
      return line;
    }

    switch (event.type) {
      case "assistant":
        return renderAssistantTurn(event);
      case "user":
        return renderToolResults(event);
      case "rate_limit_event":
        return renderRateLimit(event);
      case "system":
        return event.subtype === "init" ? renderInit(event) : null;
      case "result":
        return renderResultFooter(event);
      default:
        // An unknown structured event — drop it rather than spam raw JSON.
        return null;
    }
  },

  // The caller-facing text of a finished session: the terminal `result` event's
  // `result` field, which Claude populates with the final assistant message.
  // Earlier event lines (hook noise, init, per-turn assistant/tool events) are
  // not the caller's concern and are skipped.
  extractResultText(stdout: string): string {
    let resultText: string | null = null;

    for (const event of parseEvents(stdout)) {
      if (event.type === "result" && typeof event.result === "string") {
        resultText = event.result;
      }
    }

    return resultText ?? NO_RESULT_FALLBACK;
  }
};

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  result?: unknown;
  model?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
  message?: { content?: unknown };
  rate_limit_info?: { status?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
}

// Renders an assistant turn's content blocks, one per line: prose as-is, thinking
// behind a marker, and each tool call as an action line. A turn can carry several
// blocks (e.g. thinking then a tool call), so the rendered lines are joined.
function renderAssistantTurn(event: ClaudeEvent): string | null {
  const lines = contentBlocks(event)
    .map(renderAssistantBlock)
    .filter((line): line is string => line !== null);

  return lines.length > 0 ? lines.join("\n") : null;
}

function renderAssistantBlock(block: ContentBlock): string | null {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : null;
    case "thinking":
      return typeof block.thinking === "string" ? `💭 ${block.thinking}` : null;
    case "tool_use":
      return `→ ${String(block.name)}: ${summarizeToolInput(block.input)}`;
    default:
      return null;
  }
}

// Picks the most telling field of a tool's input for a one-line summary — the
// command for Bash, the path for a file edit, and so on — falling back to compact
// JSON for an unrecognized tool. Keeps the action line short and scannable.
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const fields = input as Record<string, unknown>;
  const telling = ["command", "file_path", "path", "pattern", "url", "query"];
  for (const field of telling) {
    if (typeof fields[field] === "string") {
      return truncateToLine(fields[field] as string, TOOL_RESULT_PREVIEW_LENGTH);
    }
  }

  return truncateToLine(JSON.stringify(fields), TOOL_RESULT_PREVIEW_LENGTH);
}

function renderToolResults(event: ClaudeEvent): string | null {
  const previews = contentBlocks(event)
    .filter((block) => block.type === "tool_result")
    .map((block) => `← ${truncateToLine(toolResultText(block.content), TOOL_RESULT_PREVIEW_LENGTH)}`);

  return previews.length > 0 ? previews.join("\n") : null;
}

// A tool result's content is either a plain string or an array of text blocks;
// flatten both to one string for the preview.
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("");
  }

  return "";
}

function renderRateLimit(event: ClaudeEvent): string | null {
  const status = event.rate_limit_info?.status;
  // `allowed` is a routine heartbeat and pure noise; only an actual wait/throttle
  // is worth surfacing, since it explains an otherwise-silent pause.
  if (typeof status !== "string" || status === "allowed") {
    return null;
  }

  return `⏳ rate limit (${status})`;
}

function renderInit(event: ClaudeEvent): string {
  return typeof event.model === "string"
    ? `● claude session (model: ${event.model})`
    : "● claude session";
}

function renderResultFooter(event: ClaudeEvent): string {
  const turns = typeof event.num_turns === "number" ? event.num_turns : null;
  const seconds = typeof event.duration_ms === "number" ? Math.round(event.duration_ms / 1000) : null;

  if (turns === null || seconds === null) {
    return "✓ done";
  }

  return `✓ done (${turns} turn${turns === 1 ? "" : "s"}, ${seconds}s)`;
}

function contentBlocks(event: ClaudeEvent): ContentBlock[] {
  const content = event.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

// Collapses to the first line and caps the length so one rendered entry is always
// a single short line, regardless of how large the underlying text is.
function truncateToLine(text: string, max: number): string {
  const firstLine = text.split("\n", 1)[0];
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function tryParseEvent(line: string): ClaudeEvent | null {
  if (!line.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as ClaudeEvent) : null;
  } catch {
    return null;
  }
}

// Parses each non-empty line as a standalone JSON event, silently skipping any
// line that is not a JSON object so one malformed line never aborts decoding.
function parseEvents(stdout: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];

  for (const line of stdout.split("\n")) {
    const event = tryParseEvent(line);
    if (event) {
      events.push(event);
    }
  }

  return events;
}
