import { accent, bold, italic, muted, COLORS_ENABLED } from "./display";

/**
 * Streaming markdown-to-ANSI renderer.
 *
 * Buffers incoming character deltas and emits formatted lines to stdout.
 * Handles: headers, bold, italic, inline code, fenced code blocks,
 * bullet/numbered lists.
 */
export class MarkdownRenderer {
  private buffer = "";
  private inCodeBlock = false;
  private codeLang = "";

  write(delta: string): void {
    this.buffer += delta;
    this.drainLines(false);
  }

  flush(): void {
    this.drainLines(true);
    if (this.inCodeBlock) {
      process.stdout.write(`  ${accent("│")}\n`);
      this.inCodeBlock = false;
      this.codeLang = "";
    }
  }

  private drainLines(final: boolean): void {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.emitLine(line);
    }
    if (final && this.buffer.length > 0) {
      this.emitLine(this.buffer);
      this.buffer = "";
    }
  }

  private emitLine(raw: string): void {
    if (raw.startsWith("```")) {
      if (!this.inCodeBlock) {
        this.inCodeBlock = true;
        this.codeLang = raw.slice(3).trim();
        const label = this.codeLang ? ` ${muted(this.codeLang)}` : "";
        process.stdout.write(`  ${accent("│")}${label}\n`);
      } else {
        this.inCodeBlock = false;
        this.codeLang = "";
        process.stdout.write(`  ${accent("│")}\n`);
      }
      return;
    }

    if (this.inCodeBlock) {
      process.stdout.write(`  ${accent("│")}  ${raw}\n`);
      return;
    }

    const formatted = this.formatLine(raw);
    process.stdout.write(formatted + "\n");
  }

  private formatLine(raw: string): string {
    const headingMatch = raw.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      return `\n  ${bold(headingMatch[2]!)}`;
    }

    const bulletMatch = raw.match(/^(\s*)([-*])\s+(.*)/);
    if (bulletMatch) {
      const indent = bulletMatch[1]!;
      const content = this.formatInline(bulletMatch[3]!);
      return `  ${indent}${muted("•")} ${content}`;
    }

    const numMatch = raw.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (numMatch) {
      const indent = numMatch[1]!;
      const num = numMatch[2]!;
      const content = this.formatInline(numMatch[3]!);
      return `  ${indent}${muted(num + ".")} ${content}`;
    }

    if (raw.trim() === "") return "";

    return `  ${this.formatInline(raw)}`;
  }

  private formatInline(text: string): string {
    if (!COLORS_ENABLED) return text;

    let result = text;

    result = result.replace(/`([^`]+)`/g, (_m, code: string) => accent(code));
    result = result.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => bold(t));
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, t: string) => italic(t));
    result = result.replace(/(?<!_)__([^_]+)__(?!_)/g, (_m, t: string) => bold(t));
    result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, (_m, t: string) => italic(t));

    return result;
  }
}

export function createRenderer(): MarkdownRenderer {
  return new MarkdownRenderer();
}
