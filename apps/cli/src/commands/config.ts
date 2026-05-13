import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { invalidateGlobalConfigCache } from "../config";
import { printError } from "../display";

function configPath(): string {
  return path.join(homedir(), ".gents", "config.json");
}

function readAll(): Record<string, unknown> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* skip */
  }
  return {};
}

function writeAll(data: Record<string, unknown>): void {
  const p = configPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
    const cfg = readAll();
    cfg[key] = stored;
    writeAll(cfg);
  });

configCommand
  .command("reset")
  .description("Remove the global config file")
  .action(() => {
    const p = configPath();
    if (existsSync(p)) unlinkSync(p);
    invalidateGlobalConfigCache();
  });
