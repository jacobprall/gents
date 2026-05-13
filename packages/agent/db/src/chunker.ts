/**
 * Shared chunking, hashing, and language detection utilities used by both
 * the full indexer and the single-file write-through path.
 */

export const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  rs: "rust", go: "go", java: "java",
  kt: "kotlin", kts: "kotlin",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  rb: "ruby",
  md: "markdown", mdx: "markdown",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "scss", sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell",
  swift: "swift", scala: "scala", dart: "dart", lua: "lua",
  ex: "elixir", exs: "elixir",
  hs: "haskell", cs: "csharp", fs: "fsharp", vb: "vb", php: "php",
};

export function languageFromExt(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGE_MAP[base.slice(dot + 1).toLowerCase()] ?? null;
}

export function sha256Hex(data: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  if (typeof data === "string") h.update(data);
  else h.update(data);
  return h.digest("hex");
}

export interface ChunkPart {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Split on double-newline boundaries then subdivide long blocks with overlap.
 * Tracks actual newlines consumed (including multiple blank lines) to keep
 * line numbers accurate.
 */
export function chunkFileContent(
  content: string,
  chunkSize: number,
  overlap: number,
  minChunk: number,
): ChunkPart[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const totalLines = lines.length;
  const result: ChunkPart[] = [];

  let i = 0;
  while (i < totalLines) {
    while (i < totalLines && lines[i]!.trim() === "") i++;
    if (i >= totalLines) break;

    const blockStart = i;
    while (i < totalLines && !(i > blockStart && lines[i]!.trim() === "" && (i + 1 >= totalLines || lines[i + 1]!.trim() === ""))) {
      i++;
    }
    const blockEnd = i;
    const blockLines = lines.slice(blockStart, blockEnd);
    const blockText = blockLines.join("\n");

    if (blockText.length <= chunkSize) {
      const t = blockText.trim();
      if (t && (t.length >= minChunk || result.length === 0)) {
        result.push({ text: t, startLine: blockStart + 1, endLine: blockEnd });
      } else if (t && result.length > 0) {
        const prev = result[result.length - 1]!;
        prev.text = `${prev.text}\n\n${t}`;
        prev.endLine = blockEnd;
      }
    } else {
      let li = 0;
      while (li < blockLines.length) {
        let accLen = 0;
        let lj = li;
        while (lj < blockLines.length && accLen < chunkSize) {
          accLen += blockLines[lj]!.length + (lj > li ? 1 : 0);
          lj++;
        }
        if (lj === li) lj = li + 1;
        const slice = blockLines.slice(li, lj).join("\n").trim();
        if (slice) {
          if (slice.length >= minChunk || result.length === 0) {
            result.push({ text: slice, startLine: blockStart + li + 1, endLine: blockStart + lj });
          } else {
            const prev = result[result.length - 1]!;
            prev.text = `${prev.text}\n\n${slice}`;
            prev.endLine = blockStart + lj;
          }
        }
        if (lj >= blockLines.length) break;
        const overlapLines = Math.max(1, Math.ceil(overlap / 80));
        li = Math.max(li + 1, lj - overlapLines);
      }
    }

    while (i < totalLines && lines[i]!.trim() === "") i++;
  }

  return result;
}
