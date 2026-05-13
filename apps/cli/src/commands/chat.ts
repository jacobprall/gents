import { createAgentLoop, createChildLoopFactory, type LoopEvent } from "@gents/agent-loop";
import {
  compactConversation,
  getCurrentTurn,
  getIndexStatus,
  getSessionMetrics,
  hybridSearch,
  indexCodebase,
  loadSkillsFromDir,
} from "@gents/agent-db";
import {
  confirmationGate,
  costGuard,
  createHookPipeline,
  credentialRedactor,
  toolGovernance,
} from "@gents/agent-hooks";
import { createToolRegistry, registerBuiltinTools } from "@gents/agent-tools";
import { Command } from "commander";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  bold,
  cyan,
  dim,
  printCost,
  printDebug,
  printError,
  printInfo,
  printToolComplete,
  printToolError,
  printToolStart,
} from "../display";
import { resolveConfig } from "../config";
import { createDefaultPrompt } from "../prompt";
import { openSession } from "../session";

function handleLoopEvent(event: LoopEvent): void {
  switch (event.type) {
    case "turn.started":
      break;

    case "llm.streaming":
      process.stdout.write(event.delta);
      break;

    case "llm.complete":
      process.stdout.write("\n");
      break;

    case "tool.calling":
      printToolStart(event.name, event.input);
      break;

    case "tool.complete":
      printToolComplete(event.name, event.output, event.durationMs);
      break;

    case "tool.error":
      printToolError(event.name, event.error);
      break;

    case "turn.complete":
      printCost({
        model: event.cost.model,
        inputTokens: event.cost.inputTokens,
        outputTokens: event.cost.outputTokens,
        costUsd: event.cost.costUsd,
        turnNumber: event.cost.turnNumber,
      });
      break;

    case "error":
      printError(event.error.message);
      break;

    case "paused":
      printInfo(dim(`Paused: ${event.reason}`));
      break;
  }
}

async function confirmationPromptFn(toolName: string, input: unknown): Promise<boolean> {
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const preview =
      typeof input === "object" && input !== null ? JSON.stringify(input).slice(0, 200) : String(input);
    rl.question(`Approve tool "${toolName}"? ${preview}\n[y/N] `, (ans) => {
      rl.close();
      const t = ans.trim().toLowerCase();
      resolve(t === "y" || t === "yes");
    });
  });
}

async function handleSlashCommand(
  line: string,
  db: Parameters<typeof getCurrentTurn>[0],
  repoPath: string,
): Promise<void> {
  const body = line.slice(1).trim();
  const firstSpace = body.indexOf(" ");
  const cmd = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  const argRest = firstSpace === -1 ? "" : body.slice(firstSpace).trim();

  switch (cmd) {
    case "help": {
      printInfo(`
  ${cyan("/compact")} [summary]  — Compact conversation history (summary optional)
  ${cyan("/search")} <query>   — Hybrid search over the codebase index
  ${cyan("/index")}           — Rebuild/update the codebase index for this repo
  ${cyan("/cost")}            — Session cost and token metrics
  ${cyan("/status")}          — Index + session status
  ${cyan("/exit")}, ${cyan("/quit")}    — Quit the REPL`);
      break;
    }
    case "compact": {
      const turn = getCurrentTurn(db);
      const summary =
        argRest.length > 0 ? argRest : "[Compaction via /compact — summarize earlier turns in subsequent context]";
      compactConversation(db, turn, summary);
      printInfo(dim(`Compaction marker recorded through turn ${String(turn)}.`));
      break;
    }
    case "search": {
      const q = argRest;
      if (!q) {
        printError("Usage: /search <query>");
        break;
      }
      const hits = hybridSearch(db, q, { limit: 15 });
      if (hits.length === 0) {
        printInfo("No hits.");
        break;
      }
      for (const r of hits) {
        console.log(
          `\n  ${cyan(r.path)}:${String(r.startLine)}-${String(r.endLine)} ${dim(`(score: ${r.score.toFixed(2)})`)}`,
        );
        console.log(`  ${"─".repeat(40)}`);
        const lines = r.chunkText.split("\n");
        for (const ln of lines.slice(0, 6)) console.log(`  ${ln}`);
        if (lines.length > 6) console.log(dim("  ..."));
      }
      console.log("");
      break;
    }
    case "index": {
      printInfo(`Indexing ${repoPath}…`);
      const result = indexCodebase(db, repoPath);
      printInfo(
        `Indexed ${String(result.filesScanned)} files, ${String(result.chunksCreated)} chunks in ${String(result.elapsedMs)}ms`,
      );
      break;
    }
    case "cost": {
      const m = getSessionMetrics(db);
      printInfo(
        `Turns ${String(m.totalTurns)}, tokens ${String(m.totalInputTokens)} in / ${String(m.totalOutputTokens)} out, tools ${String(m.totalToolCalls)}, $${m.totalCostUsd.toFixed(6)}`,
      );
      break;
    }
    case "status": {
      const st = getIndexStatus(db);
      const m = getSessionMetrics(db);
      printInfo(`Index: ${String(st.totalFiles)} files, ${String(st.totalChunks)} chunks`);
      printInfo(`Session: ${String(m.totalTurns)} turns, cost $${m.totalCostUsd.toFixed(6)}`);
      break;
    }
    default:
      printError(`Unknown command /${cmd}. Type /help.`);
      break;
  }
}

export const chatCommand = new Command("chat")
  .description("Start or resume an interactive agent session")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .option("--new", "Force new session")
  .option("--model <model>", "Override model")
  .option("--no-index", "Skip index freshness check")
  .option("--no-confirm", "Skip tool confirmation prompts")
  .action(
    async (opts: {
      repo: string;
      session: string;
      new?: boolean;
      model?: string;
      index?: boolean;
      confirm?: boolean;
    }) => {
      try {
        const repoPath = path.resolve(opts.repo);
        const config = resolveConfig({
          model: opts.model,
          ...(typeof opts.confirm === "boolean" ? { confirmDestructive: opts.confirm } : {}),
        });
        const db = openSession(repoPath, {
          session: opts.session,
          forceNew: Boolean(opts.new),
        });

        if (opts.index !== false && config.autoIndex) {
          const status = getIndexStatus(db);
          if (status.totalChunks === 0) {
            printInfo("Building initial code index...");
            const result = indexCodebase(db, repoPath);
            printInfo(
              `Indexed ${String(result.filesScanned)} files, ${String(result.chunksCreated)} chunks in ${String(result.elapsedMs)}ms`,
            );
          } else {
            printDebug(`Index: ${String(status.totalChunks)} chunks from ${String(status.totalFiles)} files`);
          }
        }

        const registry = createToolRegistry();
        registerBuiltinTools(registry);
        const toolDefs = registry.listForLLM();

        const interactive = process.stdin.isTTY ?? false;

        const hookList = [
          costGuard({ maxCostPerSession: config.maxCostPerSession }),
          credentialRedactor(),
          toolGovernance({}),
          ...(config.confirmDestructive && interactive
            ? [
                confirmationGate({
                  requireConfirmation: ["bash", "file_write", "file_edit", "git_commit"],
                  promptFn: confirmationPromptFn,
                }),
              ]
            : []),
        ];
        const hooks = createHookPipeline(hookList);

        const skills = loadSkillsFromDir(path.join(repoPath, ".gents", "skills"));
        if (skills.length > 0) {
          printDebug(`Loaded ${String(skills.length)} skill(s): ${skills.map((s) => s.name).join(", ")}`);
        }

        const prompt = createDefaultPrompt(toolDefs, skills);

        const childLoopFactory = createChildLoopFactory({
          model: config.model,
          apiKey: config.apiKey,
          parentRegistry: registry,
        });

        const loop = createAgentLoop({
          model: config.model,
          apiKey: config.apiKey,
          tools: registry,
          hooks,
          ctx: prompt,
          repoPath,
          maxCostPerSession: config.maxCostPerSession,
          childLoopFactory,
        });

        if (!interactive) {
          const chunks: string[] = [];
          process.stdin.setEncoding("utf8");
          for await (const chunk of process.stdin) {
            chunks.push(chunk as string);
          }
          const piped = chunks.join("").trim();
          if (!piped) {
            printError("No input received from stdin.");
            process.exit(1);
          }
          printDebug(`Piped input (${String(piped.length)} chars), running single turn`);
          for await (const event of loop.run(db, piped)) {
            handleLoopEvent(event);
          }
          process.exit(0);
        }

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        const shutdown = (code?: number): void => {
          rl.close();
          process.exit(code ?? 0);
        };

        rl.on("close", () => {
          printInfo(dim("Goodbye."));
        });

        process.once("SIGINT", () => {
          process.stdout.write("\n");
          shutdown(130);
        });

        console.log(`\n  ${bold("gents")} v0.1.0`);
        console.log(`  Session: ${opts.session} | Model: ${config.model}`);
        console.log(`  Repo: ${repoPath}`);
        console.log(`  Type ${cyan("/help")} for commands, ${cyan("/exit")} to quit.\n`);

        let busy = false;

        const promptUser = (): void => {
          rl.question("\n  You: ", (input: string) => {
            void (async () => {
              const trimmed = input.trim();
              if (!trimmed || trimmed === "/exit" || trimmed === "/quit") {
                shutdown(0);
                return;
              }

              if (trimmed.startsWith("/")) {
                await handleSlashCommand(trimmed, db, repoPath);
                promptUser();
                return;
              }

              if (busy) {
                printInfo("Still processing the previous message. Please wait.");
                promptUser();
                return;
              }

              busy = true;
              process.stdout.write("\n");
              try {
                for await (const event of loop.run(db, trimmed)) {
                  handleLoopEvent(event);
                }
              } catch (e) {
                printError(e instanceof Error ? e.message : String(e));
              }
              busy = false;

              promptUser();
            })();
          });
        };

        promptUser();
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    },
  );
