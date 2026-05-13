import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import { bold, dim, green, red, yellow } from "../display";
import { globalConfigPath } from "../config";
import { getDbPath, getGentsDir } from "../session";

type Status = "pass" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail?: string;
}

function icon(s: Status): string {
  switch (s) {
    case "pass":
      return green("✔");
    case "warn":
      return yellow("⚠");
    case "fail":
      return red("✖");
  }
}

function checkBunRuntime(): Check {
  const version = typeof Bun !== "undefined" ? Bun.version : undefined;
  if (!version) {
    return { label: "Bun runtime", status: "fail", detail: "Not running under Bun. Install from https://bun.sh" };
  }
  const [major] = version.split(".");
  if (Number(major) < 1) {
    return { label: "Bun runtime", status: "warn", detail: `v${version} — upgrade to >=1.0 recommended` };
  }
  return { label: "Bun runtime", status: "pass", detail: `v${version}` };
}

function checkApiKey(): Check {
  if (process.env.ANTHROPIC_API_KEY) {
    const key = process.env.ANTHROPIC_API_KEY;
    const masked = `${key.slice(0, 8)}...${key.slice(-4)}`;
    return { label: "Anthropic API key", status: "pass", detail: `env ANTHROPIC_API_KEY (${masked})` };
  }

  const cfgPath = globalConfigPath();
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      if (typeof raw.anthropic_api_key === "string" && raw.anthropic_api_key.length > 0) {
        const key = raw.anthropic_api_key;
        const masked = `${key.slice(0, 8)}...${key.slice(-4)}`;
        return { label: "Anthropic API key", status: "pass", detail: `config (${masked})` };
      }
    } catch {
      /* handled below */
    }
  }

  return {
    label: "Anthropic API key",
    status: "fail",
    detail: "Not found. Set ANTHROPIC_API_KEY or run: gents config set anthropic_api_key <key>",
  };
}

function checkGlobalConfig(): Check {
  const cfgPath = globalConfigPath();
  if (!existsSync(cfgPath)) {
    return { label: "Global config", status: "warn", detail: `${cfgPath} — not created yet (using defaults)` };
  }

  try {
    const content = readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { label: "Global config", status: "fail", detail: `${cfgPath} — not a JSON object` };
    }
  } catch (e) {
    return {
      label: "Global config",
      status: "fail",
      detail: `${cfgPath} — invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { label: "Global config", status: "pass", detail: cfgPath };
}

function checkConfigPermissions(): Check {
  const cfgPath = globalConfigPath();
  if (!existsSync(cfgPath)) {
    return { label: "Config permissions", status: "pass", detail: "No config file yet" };
  }

  try {
    const st = statSync(cfgPath);
    const mode = (st.mode & 0o777).toString(8);
    if ((st.mode & 0o077) !== 0) {
      return {
        label: "Config permissions",
        status: "warn",
        detail: `${cfgPath} is ${mode} — recommend 600 (contains API key). Run: chmod 600 "${cfgPath}"`,
      };
    }
    return { label: "Config permissions", status: "pass", detail: `${mode}` };
  } catch {
    return { label: "Config permissions", status: "warn", detail: "Could not stat config file" };
  }
}

async function checkGit(): Promise<Check> {
  try {
    const proc = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    const match = text.match(/(\d+\.\d+\.\d+)/);
    return { label: "Git", status: "pass", detail: match ? `v${match[1]}` : text.trim() };
  } catch {
    return { label: "Git", status: "warn", detail: "git not found — git tools will be unavailable" };
  }
}

function checkRepoGentsDir(repoPath: string): Check {
  const gentsDir = getGentsDir(repoPath);
  if (!existsSync(gentsDir)) {
    return {
      label: "Repo .gents/ directory",
      status: "warn",
      detail: `Not found at ${gentsDir} — will be created on first gents chat`,
    };
  }
  return { label: "Repo .gents/ directory", status: "pass", detail: gentsDir };
}

function checkDefaultSession(repoPath: string): Check {
  const dbPath = getDbPath(repoPath, "default");
  if (!existsSync(dbPath)) {
    return { label: "Default session DB", status: "warn", detail: "No default session yet" };
  }

  try {
    const st = statSync(dbPath);
    const sizeKb = (st.size / 1024).toFixed(0);
    return { label: "Default session DB", status: "pass", detail: `${dbPath} (${sizeKb} KB)` };
  } catch {
    return { label: "Default session DB", status: "warn", detail: "Could not stat database file" };
  }
}

function checkSessions(repoPath: string): Check {
  const sessionsDir = path.join(getGentsDir(repoPath), "sessions");
  if (!existsSync(sessionsDir)) {
    return { label: "Named sessions", status: "pass", detail: "None (only default)" };
  }

  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".agent.db"));
    if (files.length === 0) {
      return { label: "Named sessions", status: "pass", detail: "None" };
    }
    const names = files.map((f) => f.replace(".agent.db", ""));
    return { label: "Named sessions", status: "pass", detail: `${String(files.length)}: ${names.join(", ")}` };
  } catch {
    return { label: "Named sessions", status: "warn", detail: "Could not read sessions directory" };
  }
}

function checkSqliteExtensions(repoPath: string): Check {
  const dbPath = getDbPath(repoPath, "default");
  if (!existsSync(dbPath)) {
    return {
      label: "SQLite extensions",
      status: "warn",
      detail: "No database to test — run gents chat first, then re-check",
    };
  }

  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const exts: string[] = [];

    try {
      db.prepare("SELECT vector_version()").get();
      exts.push("sqlite-vector");
    } catch {
      /* not loaded */
    }

    try {
      db.prepare("SELECT llm_version()").get();
      exts.push("sqlite-ai");
    } catch {
      /* not loaded */
    }

    db.close();

    if (exts.length === 0) {
      return {
        label: "SQLite extensions",
        status: "warn",
        detail: "Neither sqlite-vector nor sqlite-ai detected — semantic search and local embeddings unavailable",
      };
    }
    return { label: "SQLite extensions", status: "pass", detail: exts.join(", ") };
  } catch (e) {
    return {
      label: "SQLite extensions",
      status: "warn",
      detail: `Could not probe: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export const doctorCommand = new Command("doctor")
  .description("Check environment and configuration")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--json", "Output as JSON")
  .action(async (opts: { repo: string; json?: boolean }) => {
    const repoPath = path.resolve(opts.repo);

    const checks: Check[] = [
      checkBunRuntime(),
      checkApiKey(),
      checkGlobalConfig(),
      checkConfigPermissions(),
      await checkGit(),
      checkRepoGentsDir(repoPath),
      checkDefaultSession(repoPath),
      checkSessions(repoPath),
      checkSqliteExtensions(repoPath),
    ];

    if (opts.json) {
      console.log(JSON.stringify(checks, null, 2));
      return;
    }

    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;

    console.log(`\n  ${bold("gents doctor")}\n`);

    for (const check of checks) {
      const detail = check.detail ? dim(` — ${check.detail}`) : "";
      console.log(`  ${icon(check.status)} ${check.label}${detail}`);
    }

    console.log("");

    if (fails > 0) {
      console.log(`  ${red(String(fails))} problem${fails > 1 ? "s" : ""} found.`);
      process.exitCode = 1;
    } else if (warns > 0) {
      console.log(`  ${yellow(String(warns))} warning${warns > 1 ? "s" : ""}, no critical issues.`);
    } else {
      console.log(`  ${green("All checks passed.")}`);
    }

    console.log("");
  });
