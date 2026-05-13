import type { AgentDB, SearchOptions, SearchResult } from "./types";

function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}

const RRF_K = 60;

function ftsMatchExpression(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (terms.length === 0) return '""';
  return terms.join(" AND ");
}

function matchesFilters(r: SearchResult, languages?: string[], paths?: string[]): boolean {
  if (languages != null && languages.length > 0) {
    const lang = r.language ?? "";
    if (!languages.includes(lang)) return false;
  }
  if (paths != null && paths.length > 0) {
    const hit = paths.some((p) => globLikeMatch(r.path, p));
    if (!hit) return false;
  }
  return true;
}

/** Minimal glob: supports * and **; always forward-slash. */
function globLikeMatch(path: string, pattern: string): boolean {
  const norm = path.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/");
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0DS\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0DS\0/g, ".*");
  const re = new RegExp(`^${esc}$`);
  return re.test(norm) || re.test(norm.split("/").pop() ?? "");
}

function probeVectorScan(database: import("bun:sqlite").Database): boolean {
  try {
    const stmt = database.prepare(`SELECT 1 FROM vector_quantize_scan('code_chunks', 'embedding', ?, 1) LIMIT 1`);
    stmt.get(new Uint8Array(4));
    return true;
  } catch {
    return false;
  }
}

function tryQueryEmbedding(database: import("bun:sqlite").Database, query: string): Uint8Array | null {
  const prefixed = `search_query: ${query}`;
  try {
    const row = database.prepare(`SELECT llm_embed_generate(?) AS e`).get(prefixed) as { e: Uint8Array | Buffer } | undefined;
    if (!row?.e) return null;
    return new Uint8Array(row.e);
  } catch {
    return null;
  }
}

interface Bm25Row {
  path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  language: string | null;
  chunk_text: string;
}

function bm25Search(database: import("bun:sqlite").Database, match: string, fetchLimit: number): SearchResult[] {
  try {
    const rows = database
      .prepare(
        `SELECT c.path AS path, c.chunk_index AS chunk_index, c.start_line AS start_line,
                c.end_line AS end_line, c.language AS language, c.chunk_text AS chunk_text
         FROM code_fts AS f
         JOIN code_chunks AS c ON c.rowid = f.rowid
         WHERE f MATCH ?
         ORDER BY bm25(code_fts)
         LIMIT ?`,
      )
      .all(match, fetchLimit) as Bm25Row[];
    return rows.map((r) => ({
      path: r.path,
      chunkIndex: r.chunk_index,
      startLine: r.start_line,
      endLine: r.end_line,
      language: r.language,
      chunkText: r.chunk_text,
      score: 0,
    }));
  } catch (e) {
    throw sqlError("hybridSearch (BM25)", e);
  }
}

interface VecRow {
  path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  language: string | null;
  chunk_text: string;
}

function vectorSearch(database: import("bun:sqlite").Database, embedding: Uint8Array, fetchLimit: number): SearchResult[] {
  const rows = database
    .prepare(
      `SELECT c.path AS path, c.chunk_index AS chunk_index, c.start_line AS start_line,
              c.end_line AS end_line, c.language AS language, c.chunk_text AS chunk_text
       FROM code_chunks AS c
       JOIN vector_quantize_scan('code_chunks', 'embedding', ?, ?) AS v ON c.rowid = v.rowid`,
    )
    .all(embedding, fetchLimit) as VecRow[];
  return rows.map((r) => ({
    path: r.path,
    chunkIndex: r.chunk_index,
    startLine: r.start_line,
    endLine: r.end_line,
    language: r.language,
    chunkText: r.chunk_text,
    score: 0,
  }));
}

function mergeRrf(
  bm25List: SearchResult[],
  vectorList: SearchResult[],
  bm25Weight: number,
  vectorWeight: number,
  limit: number,
  languages?: string[],
  paths?: string[],
): SearchResult[] {
  const scores = new Map<string, number>();
  const rows = new Map<string, SearchResult>();

  const add = (list: SearchResult[], weight: number) => {
    list.forEach((r, i) => {
      const rank = i + 1;
      const key = `${r.path}\0${r.chunkIndex}`;
      scores.set(key, (scores.get(key) ?? 0) + weight * (1 / (RRF_K + rank)));
      if (!rows.has(key)) rows.set(key, { ...r, score: 0 });
    });
  };

  add(bm25List, bm25Weight);
  add(vectorList, vectorWeight);

  const merged: SearchResult[] = [];
  for (const [key, base] of rows) {
    const s = scores.get(key) ?? 0;
    const next = { ...base, score: s };
    if (!matchesFilters(next, languages, paths)) continue;
    merged.push(next);
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

/** BM25 via FTS5, optional vector ANN when extensions + embeddings exist; fused with weighted RRF (k=60). */
export function hybridSearch(db: AgentDB, query: string, opts?: SearchOptions): SearchResult[] {
  if (!query.trim()) return [];

  const limit = opts?.limit ?? 20;
  const bm25Weight = opts?.bm25Weight ?? 0.3;
  const vectorWeight = opts?.vectorWeight ?? 0.7;
  const fetchLimit = Math.max(limit * 5, 50);

  const match = ftsMatchExpression(query);
  const bm25Raw = bm25Search(db.db, match, fetchLimit);
  const bm25List = bm25Raw.filter((r) => matchesFilters(r, opts?.languages, opts?.paths));

  let vectorList: SearchResult[] = [];
  if (probeVectorScan(db.db)) {
    const emb = tryQueryEmbedding(db.db, query);
    if (emb) {
      try {
        vectorList = vectorSearch(db.db, emb, fetchLimit).filter((r) => matchesFilters(r, opts?.languages, opts?.paths));
      } catch (e) {
        console.warn(`[gents] vector search failed, falling back to BM25-only: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (vectorList.length === 0) {
    const wSum = bm25Weight + vectorWeight;
    const scale = wSum > 0 ? 1 / wSum : 1;
    return mergeRrf(bm25List, [], bm25Weight * scale, 0, limit, opts?.languages, opts?.paths);
  }

  return mergeRrf(bm25List, vectorList, bm25Weight, vectorWeight, limit, opts?.languages, opts?.paths);
}
