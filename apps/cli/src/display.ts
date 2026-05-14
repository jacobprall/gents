export const COLORS_ENABLED = !process.env.GENTS_NO_COLOR && !process.env.NO_COLOR;

const TRUECOLOR =
  COLORS_ENABLED &&
  (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

function ansi(code: string): (s: string) => string {
  return (s) => (COLORS_ENABLED ? `\x1b[${code}m${s}\x1b[0m` : s);
}

function rgb(r: number, g: number, b: number, fallbackCode: string): (s: string) => string {
  if (!COLORS_ENABLED) return (s) => s;
  if (TRUECOLOR) return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
  return ansi(fallbackCode);
}

// ── Base formatters ──────────────────────────────────────────────────────

export const dim = ansi("2");
export const bold = ansi("1");
export const italic = ansi("3");

// ── Semantic palette ─────────────────────────────────────────────────────

export const accent = rgb(138, 180, 248, "36");
export const success = rgb(129, 199, 132, "32");
export const error = rgb(239, 154, 154, "31");
export const warning = rgb(255, 213, 79, "33");

export const muted = dim;

// ── Spinner ──────────────────────────────────────────────────────────────

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;

  start(text: string): void {
    this.frameIdx = 0;
    this.render(text);
    this.interval = setInterval(() => {
      this.frameIdx++;
      this.render(text);
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write("\r\x1b[2K");
    }
  }

  private render(text: string): void {
    const frame = BRAILLE_FRAMES[this.frameIdx % BRAILLE_FRAMES.length]!;
    process.stdout.write(`\r\x1b[2K  ${muted(frame)} ${muted(text)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function shortenPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Tool output ──────────────────────────────────────────────────────────

export function printToolStart(name: string, input: unknown): void {
  const summary =
    typeof input === "object" && input !== null
      ? JSON.stringify(input).slice(0, 80)
      : String(input);
  process.stdout.write(`  ${muted("┌")} ${accent(name)} ${muted(summary)}\n`);
}

export function printToolComplete(name: string, output: string, durationMs: number): void {
  const isFileOp = /^file_(edit|write|patch)$/.test(name);
  const lines = output.split("\n");

  if (isFileOp && output.includes("@@")) {
    printDiffLines(lines);
  } else {
    const maxShow = 5;
    for (const line of lines.slice(0, maxShow)) {
      process.stdout.write(`  ${muted("│")} ${line}\n`);
    }
    if (lines.length > maxShow) {
      process.stdout.write(
        `  ${muted("│")} ${muted(`... ${String(lines.length - maxShow)} more lines`)}\n`,
      );
    }
  }

  process.stdout.write(`  ${muted("└")} ${muted(formatDuration(durationMs))}\n\n`);
}

function printDiffLines(lines: string[]): void {
  for (const line of lines) {
    if (line.startsWith("+")) {
      process.stdout.write(`  ${muted("│")} ${success(line)}\n`);
    } else if (line.startsWith("-")) {
      process.stdout.write(`  ${muted("│")} ${error(line)}\n`);
    } else if (line.startsWith("@@")) {
      process.stdout.write(`  ${muted("│")} ${muted(line)}\n`);
    } else {
      process.stdout.write(`  ${muted("│")} ${line}\n`);
    }
  }
}

export function printToolError(_name: string, err: string): void {
  process.stdout.write(`  ${muted("└")} ${error("error:")} ${err}\n\n`);
}

// ── Cost / turn footer ──────────────────────────────────────────────────

export function printCost(cost: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turnNumber: number;
}): void {
  const parts = [
    `turn ${String(cost.turnNumber)}`,
    `${humanTokens(cost.inputTokens)} in`,
    `${humanTokens(cost.outputTokens)} out`,
    `$${cost.costUsd.toFixed(4)}`,
    cost.model,
  ];
  process.stdout.write(muted(`  ${parts.join(" · ")}\n`));
}

// ── Turn separator ──────────────────────────────────────────────────────

export function printTurnSeparator(): void {
  process.stdout.write(`\n${muted("  ────────────────────────────────────────")}\n`);
}

// ── Standard messages ────────────────────────────────────────────────────

export function printError(msg: string): void {
  process.stderr.write(`${error("error:")} ${msg}\n`);
}

export function printInfo(msg: string): void {
  process.stdout.write(`${muted(msg)}\n`);
}

export function printWarn(msg: string): void {
  process.stderr.write(`${warning("warning:")} ${msg}\n`);
}

export function printDebug(msg: string): void {
  if (process.env.GENTS_VERBOSE === "1" || process.env.DEBUG) {
    process.stderr.write(`${muted(`[debug] ${msg}`)}\n`);
  }
}

// ── Banner ──────────────────────────────────────────────────────────────

const BOWTIE = [
  `  ${accent("|\\                     /|")}`,
  `  ${accent("|  \\                 /  |")}`,
  `  ${accent("|    \\             /    |")}`,
  `  ${accent("|      \\         /      |")}`,
  `  ${accent("|       \\_______/       |")}`,
  `  ${accent("|       |       |       |")}`,
  `  ${accent("|       |       |       |")}`,
  `  ${accent("|       |_______|       |")}`,
  `  ${accent("|       /       \\       |")}`,
  `  ${accent("|      /         \\      |")}`,
  `  ${accent("|    /             \\    |")}`,
  `  ${accent("|  /                 \\  |")}`,
  `  ${accent("|/                     \\|")}`,
];

export function printBanner(opts: {
  version: string;
  session: string;
  model: string;
  provider?: string;
  repoPath: string;
}): void {
  const repo = shortenPath(opts.repoPath);

  const title = `${bold("gents")} ${muted(`v${opts.version}`)}`;
  const titleRaw = `gents v${opts.version}`;
  const pad = Math.max(0, Math.floor((25 - titleRaw.length) / 2));

  const modelDisplay = opts.provider && opts.provider !== "anthropic"
    ? `${opts.model} ${muted(`(${opts.provider})`)}`
    : opts.model;

  process.stdout.write("\n");
  for (const line of BOWTIE) {
    process.stdout.write(line + "\n");
  }
  process.stdout.write(`  ${" ".repeat(pad)}${title}\n`);
  process.stdout.write("\n");
  process.stdout.write(`  ${muted("session")}  ${opts.session}\n`);
  process.stdout.write(`  ${muted("model")}    ${modelDisplay}\n`);
  process.stdout.write(`  ${muted("repo")}     ${repo}\n`);
  process.stdout.write("\n");
  process.stdout.write(
    `  Type ${accent("/help")} for commands ${muted("·")} ${accent("/exit")} to quit\n\n`,
  );
}

// ── Help ─────────────────────────────────────────────────────────────────

export function printHelp(): void {
  const cmd = (name: string, args: string, desc: string): string => {
    const left = `${accent(name)} ${muted(args)}`;
    const rawLen = name.length + 1 + args.length;
    const padding = Math.max(1, 20 - rawLen);
    return `  ${left}${" ".repeat(padding)}${muted(desc)}`;
  };

  process.stdout.write("\n");
  process.stdout.write(`  ${bold("Commands")}\n\n`);
  process.stdout.write(cmd("/compact", "[msg]", "Compact conversation history") + "\n");
  process.stdout.write(cmd("/fresh", "     ", "Start a fresh session (same agent)") + "\n");
  process.stdout.write(cmd("/sessions", "  ", "List sessions for current agent") + "\n");
  process.stdout.write(cmd("/agents", "    ", "List agents in this repo") + "\n");
  process.stdout.write(cmd("/search", " <q>", "Search the codebase index") + "\n");
  process.stdout.write(cmd("/index", "    ", "Rebuild the codebase index") + "\n");
  process.stdout.write(cmd("/model", " [id]", "List or switch models") + "\n");
  process.stdout.write("\n");
  process.stdout.write(cmd("/cost", "     ", "Session cost and token usage") + "\n");
  process.stdout.write(cmd("/status", "   ", "Index and session status") + "\n");
  process.stdout.write(cmd("/help", "     ", "Show this help") + "\n");
  process.stdout.write("\n");
  process.stdout.write(cmd("/exit", "     ", "End session") + "\n");
  process.stdout.write("\n");
}
