import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

export interface ResolvedConfig {
  apiKey: string;
  model: string;
  maxCostPerSession?: number;
  confirmDestructive: boolean;
  autoIndex: boolean;
}

let _globalcache: Record<string, unknown> | null | undefined;

export function globalConfigPath(): string {
  return pathJoin(homedir(), ".gents", "config.json");
}

function loadGlobalRaw(): Record<string, unknown> {
  if (_globalcache !== undefined) {
    return _globalcache ?? {};
  }
  const p = globalConfigPath();
  if (!existsSync(p)) {
    _globalcache = null;
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      _globalcache = raw as Record<string, unknown>;
      return _globalcache;
    }
  } catch {
    /* skip */
  }
  _globalcache = null;
  return {};
}

export function invalidateGlobalConfigCache(): void {
  _globalcache = undefined;
}

/** Global config value as string (`true` / `false` for booleans), or undefined if absent. */
function readGlobalConfig(key: string): string | undefined {
  const obj = loadGlobalRaw();
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

export function resolveConfig(flags: Partial<ResolvedConfig>): ResolvedConfig {
  const apiKey =
    flags.apiKey ?? process.env.ANTHROPIC_API_KEY ?? readGlobalConfig("anthropic_api_key");
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key found. Set ANTHROPIC_API_KEY or run `gents config set anthropic_api_key <key>`",
    );
  }

  const maxParsed = parseFloat(readGlobalConfig("max_cost_per_session") ?? "0");

  const confirmDestructive =
    flags.confirmDestructive ??
    (readGlobalConfig("confirm_destructive") !== "false" && readGlobalConfig("confirm_destructive") !== "0");

  const autoIndex =
    flags.autoIndex ?? (readGlobalConfig("auto_index") !== "false" && readGlobalConfig("auto_index") !== "0");

  return {
    apiKey,
    model:
      flags.model ??
      process.env.GENTS_MODEL ??
      readGlobalConfig("model") ??
      "claude-sonnet-4-20250514",
    maxCostPerSession: flags.maxCostPerSession ?? (Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : undefined),
    confirmDestructive,
    autoIndex,
  };
}
