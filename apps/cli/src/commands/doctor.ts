import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import { bold, muted, success, error, warning } from "../display";
import { globalConfigPath } from "../config";
import { getDbPath, getGentsDir } from "../session";

type Status = "pass" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail?: string;
  group: string;
}

function icon(s: Status): string {
  switch (s) {
    case "pass":
      return success("✔");
    case "warn":
      return warning("⚠");
    case "fail":
      return error("✖");
  }
}

function checkBunRuntime(): Check {
  const version = typeof Bun !== "undefined" ? Bun.version : undefined;
  if (!version) {
    return { label: "Bun runtime", status: "fail", detail: "Not running under Bun. Install from https://bun.sh", group: "Runtime" };
  }
  const [major] = version.split(".");
  if (Number(major) < 1) {
    return { label: "Bun runtime", status: "warn", detail: `v${version} — upgrade to >=1.0 recommended`, group: "Runtime" };
  }
  return { label: "Bun runtime", status: "pass", detail: `v${version}`, group: "Runtime" };
}

interface ProviderKeySpec {
  label: string;
  envVar: string;
  configKey: string;
}

const PROVIDER_KEYS: ProviderKeySpec[] = [
  { label: "Anthropic", envVar: "ANTHROPIC_API_KEY", configKey: "anthropic_api_key" },
  { label: "OpenAI", envVar: "OPENAI_API_KEY", configKey: "openai_api_key" },
  { label: "Google", envVar: "GOOGLE_API_KEY", configKey: "google_api_key" },
];

function maskKey(key: string): string {
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function checkApiKeys(): Check[] {
  let globalRaw: Record<string, unknown> = {};
  const cfgPath = globalConfigPath();
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        globalRaw = parsed as Record<string, unknown>;
      }
    } catch { /* handled by config check */ }
  }

  const checks: Check[] = [];
  let anyFound = false;

  for (const spec of PROVIDER_KEYS) {
    const envVal = process.env[spec.envVar];
    if (envVal) {
      checks.push({
        label: `${spec.label} API key`,
        status: "pass",
        detail: `env ${spec.envVar} (${maskKey(envVal)})`,
        group: "Auth",
      });
      anyFound = true;
      continue;
    }

    const cfgVal = globalRaw[spec.configKey];
    if (typeof cfgVal === "string" && cfgVal.length > 0) {
      checks.push({
        label: `${spec.label} API key`,
        status: "pass",
        detail: `config (${maskKey(cfgVal)})`,
        group: "Auth",
      });
      anyFound = true;
      continue;
    }

    checks.push({
      label: `${spec.label} API key`,
      status: "warn",
      detail: `Not found. Set ${spec.envVar} or run: gents config set ${spec.configKey} <key>`,
      group: "Auth",
    });
  }

  if (!anyFound) {
    checks[0] = {
      ...checks[0]!,
      status: "fail",
      detail: "No API keys found. At least one provider key is required.",
    };
  }

  return checks;
}

function checkGlobalConfig(): Check {
  const cfgPath = globalConfigPath();
  if (!existsSync(cfgPath)) {
    return { label: "Global config", status: "warn", detail: `${cfgPath} — not created yet (using defaults)`, group: "Auth" };
  }

  try {
    const content = readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { label: "Global config", status: "fail", detail: `${cfgPath} — not a JSON object`, group: "Auth" };
    }
  } catch (e) {
    return {
      label: "Global config",
      status: "fail",
      detail: `${cfgPath} — invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      group: "Auth",
    };
  }

  return { label: "Global config", status: "pass", detail: cfgPath, group: "Auth" };
}

function checkConfigPermissions(): Check {
  const cfgPath = globalConfigPath();
  if (!existsSync(cfgPath)) {
    return { label: "Config permissions", status: "pass", detail: "No config file yet", group: "Auth" };
  }

  try {
    const st = statSync(cfgPath);
    const mode = (st.mode & 0o777).toString(8);
    if ((st.mode & 0o077) !== 0) {
      return {
        label: "Config permissions",
        status: "warn",
        detail: `${cfgPath} is ${mode} — recommend 600 (contains API key). Run: chmod 600 "${cfgPath}"`,
        group: "Auth",
      };
    }
    return { label: "Config permissions", status: "pass", detail: `${mode}`, group: "Auth" };
  } catch {
    return { label: "Config permissions", status: "warn", detail: "Could not stat config file", group: "Auth" };
  }
}

async function checkGit(): Promise<Check> {
  try {
    const proc = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    const match = text.match(/(\d+\.\d+\.\d+)/);
    return { label: "Git", status: "pass", detail: match ? `v${match[1]}` : text.trim(), group: "Runtime" };
  } catch {
    return { label: "Git", status: "warn", detail: "git not found — git tools will be unavailable", group: "Runtime" };
  }
}

function checkRepoGentsDir(repoPath: string): Check {
  const gentsDir = getGentsDir(repoPath);
  if (!existsSync(gentsDir)) {
    return {
      label: ".gents/ directory",
      status: "warn",
      detail: `Not found at ${gentsDir} — will be created on first gents chat`,
      group: "Repository",
    };
  }
  return { label: ".gents/ directory", status: "pass", detail: gentsDir, group: "Repository" };
}

function checkDefaultSession(repoPath: string): Check {
  const dbPath = getDbPath(repoPath, "default");
  if (!existsSync(dbPath)) {
    return { label: "Default session DB", status: "warn", detail: "No default session yet", group: "Repository" };
  }

  try {
    const st = statSync(dbPath);
    const sizeKb = (st.size / 1024).toFixed(0);
    return { label: "Default session DB", status: "pass", detail: `${dbPath} (${sizeKb} KB)`, group: "Repository" };
  } catch {
    return { label: "Default session DB", status: "warn", detail: "Could not stat database file", group: "Repository" };
  }
}

function checkSessions(repoPath: string): Check {
  const sessionsDir = path.join(getGentsDir(repoPath), "sessions");
  if (!existsSync(sessionsDir)) {
    return { label: "Named sessions", status: "pass", detail: "None (only default)", group: "Repository" };
  }

  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".agent.db"));
    if (files.length === 0) {
      return { label: "Named sessions", status: "pass", detail: "None", group: "Repository" };
    }
    const names = files.map((f) => f.replace(".agent.db", ""));
    return { label: "Named sessions", status: "pass", detail: `${String(files.length)}: ${names.join(", ")}`, group: "Repository" };
  } catch {
    return { label: "Named sessions", status: "warn", detail: "Could not read sessions directory", group: "Repository" };
  }
}

function checkSqliteExtensions(repoPath: string): Check {
  const dbPath = getDbPath(repoPath, "default");
  if (!existsSync(dbPath)) {
    return {
      label: "SQLite extensions",
      status: "warn",
      detail: "No database to test — run gents chat first, then re-check",
      group: "Runtime",
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
        group: "Runtime",
      };
    }
    return { label: "SQLite extensions", status: "pass", detail: exts.join(", "), group: "Runtime" };
  } catch (e) {
    return {
      label: "SQLite extensions",
      status: "warn",
      detail: `Could not probe: ${e instanceof Error ? e.message : String(e)}`,
      group: "Runtime",
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
      await checkGit(),
      checkSqliteExtensions(repoPath),
      ...checkApiKeys(),
      checkGlobalConfig(),
      checkConfigPermissions(),
      checkRepoGentsDir(repoPath),
      checkDefaultSession(repoPath),
      checkSessions(repoPath),
    ];

    if (opts.json) {
      console.log(JSON.stringify(checks, null, 2));
      return;
    }

    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;

    process.stdout.write(`\n  ${bold("gents doctor")}\n`);

    const groups = ["Runtime", "Auth", "Repository"];
    for (const group of groups) {
      const groupChecks = checks.filter((c) => c.group === group);
      if (groupChecks.length === 0) continue;

      process.stdout.write(`\n  ${muted(group)}\n`);
      process.stdout.write(`  ${muted("─".repeat(40))}\n`);

      for (const check of groupChecks) {
        const detail = check.detail ? muted(` — ${check.detail}`) : "";
        process.stdout.write(`  ${icon(check.status)} ${check.label}${detail}\n`);
      }
    }

    process.stdout.write("\n");

    if (fails > 0) {
      process.stdout.write(`  ${error(`${String(fails)} problem${fails > 1 ? "s" : ""} found.`)}\n`);
      process.exitCode = 1;
    } else if (warns > 0) {
      process.stdout.write(`  ${warning(`${String(warns)} warning${warns > 1 ? "s" : ""}, no critical issues.`)}\n`);
    } else {
      process.stdout.write(`  ${success("All checks passed.")}\n`);
    }

    process.stdout.write("\n");
  });
