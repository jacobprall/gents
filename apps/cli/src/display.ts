export const COLORS_ENABLED = !process.env.GENTS_NO_COLOR;

function dim(s: string): string {
  return COLORS_ENABLED ? `\x1b[2m${s}\x1b[0m` : s;
}
function bold(s: string): string {
  return COLORS_ENABLED ? `\x1b[1m${s}\x1b[0m` : s;
}
function green(s: string): string {
  return COLORS_ENABLED ? `\x1b[32m${s}\x1b[0m` : s;
}
function red(s: string): string {
  return COLORS_ENABLED ? `\x1b[31m${s}\x1b[0m` : s;
}
function cyan(s: string): string {
  return COLORS_ENABLED ? `\x1b[36m${s}\x1b[0m` : s;
}

export { bold, cyan, dim, green, red };

export function printToolStart(name: string, input: unknown): void {
  const summary =
    typeof input === "object" && input !== null ? JSON.stringify(input).slice(0, 80) : String(input);
  process.stdout.write(`  ${dim("┌")} ${cyan(name)} ${dim(summary)}\n`);
}

export function printToolComplete(name: string, output: string, durationMs: number): void {
  void name;
  const lines = output.split("\n");
  const maxShow = 10;
  for (const line of lines.slice(0, maxShow)) {
    process.stdout.write(`  ${dim("│")} ${line}\n`);
  }
  if (lines.length > maxShow) {
    process.stdout.write(`  ${dim("│")} ${dim(`...${String(lines.length - maxShow)} more lines`)}\n`);
  }
  process.stdout.write(`  ${dim("└")} ${dim(`done (${String(durationMs)}ms)`)}\n\n`);
}

export function printToolError(name: string, error: string): void {
  void name;
  process.stdout.write(`  ${dim("└")} ${red("error:")} ${error}\n\n`);
}

export function printCost(cost: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turnNumber: number;
}): void {
  process.stdout.write(
    dim(
      `  [turn ${String(cost.turnNumber)}] ${cost.model} — ${String(cost.inputTokens)} in / ${String(cost.outputTokens)} out — $${cost.costUsd.toFixed(6)}\n\n`,
    ),
  );
}

export function printError(msg: string): void {
  process.stderr.write(`${red("Error:")} ${msg}\n`);
}

export function printInfo(msg: string): void {
  process.stdout.write(`${dim(msg)}\n`);
}
