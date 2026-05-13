import { Command } from "commander";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { globalConfigPath, invalidateGlobalConfigCache } from "../config";
import { printError } from "../display";

function readAll(): Record<string, unknown> {
  const p = globalConfigPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error(`Config file at ${p} contains invalid data (expected a JSON object)`);
}

function writeAll(data: Record<string, unknown>): void {
  const p = globalConfigPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort on platforms where chmod may not apply */
  }
  invalidateGlobalConfigCache();
}

export const configCommand = new Command("config").description("Manage global ~/.gents/config.json");

configCommand
  .command("list")
  .description("Print all entries")
  .action(() => {
    const cfg = readAll();
    console.log(JSON.stringify(cfg, null, 2));
  });

configCommand
  .command("get")
  .description("Read one key")
  .argument("<key>", "Setting key")
  .action((key: string) => {
    const cfg = readAll();
    if (!(key in cfg)) {
      printError(`Key not found: ${key}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(cfg[key], null, 2));
  });

configCommand
  .command("set")
  .description("Set a key/value (parsed as JSON when valid JSON)")
  .argument("<key>", "Setting key")
  .argument("<value>", "Setting value")
  .action((key: string, value: string) => {
    let stored: unknown = value;
    try {
      stored = JSON.parse(value) as unknown;
    } catch {
      /* keep raw string */
    }
    let cfg: Record<string, unknown>;
    try {
      cfg = readAll();
    } catch (e) {
      printError(`Cannot read existing config: ${e instanceof Error ? e.message : String(e)}`);
      printError("Fix or remove ~/.gents/config.json before setting values.");
      process.exitCode = 1;
      return;
    }
    cfg[key] = stored;
    writeAll(cfg);
  });

configCommand
  .command("reset")
  .description("Remove the global config file")
  .action(() => {
    const p = globalConfigPath();
    if (existsSync(p)) unlinkSync(p);
    invalidateGlobalConfigCache();
  });
