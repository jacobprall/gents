import { createAgentLoop, createChildLoopFactory, type LoopEvent } from "@gents/agent-loop";
import {
  closeWorkspaceDB,
  compactConversation,
  getCurrentTurn,
  getIndexStatus,
  getSessionMetrics,
  hybridSearch,
  indexCodebase,
  scanSkillDirs,
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
  accent,
  muted,
  success,
  Spinner,
  printBanner,
  printCost,
  printDebug,
  printError,
  printHelp,
  printInfo,
  printToolComplete,
  printToolError,
  printToolStart,
  printTurnSeparator,
} from "../display";
import { resolveConfig } from "../config";
import { createDefaultPrompt } from "../prompt";
import { createRenderer } from "../markdown";
import { openSession, openWorkspace } from "../session";

const spinner = new Spinner();
let md = createRenderer();

function handleLoopEvent(event: LoopEvent): void {
  switch (event.type) {
    case "turn.started":
      md = createRenderer();
      spinner.start("Thinking...");
      break;

    case "llm.streaming":
      spinner.stop();
      md.write(event.delta);
      break;

    case "llm.complete":
      spinner.stop();
      md.flush();
      process.stdout.write("\n");
      break;

    case "tool.calling":
      spinner.stop();
      md.flush();
      printToolStart(event.name, event.input);
      break;

    case "tool.complete":
      printToolComplete(event.name, event.output, event.durationMs);
      spinner.start("Thinking...");
      break;

    case "tool.error":
      printToolError(event.name, event.error);
      spinner.start("Thinking...");
      break;

    case "turn.complete":
      spinner.stop();
      md.flush();
      printCost({
        model: event.cost.model,
        inputTokens: event.cost.inputTokens,
        outputTokens: event.cost.outputTokens,
        costUsd: event.cost.costUsd,
        turnNumber: event.cost.turnNumber,
      });
      break;

    case "error":
      spinner.stop();
      printError(event.error.message);
      break;

    case "paused":
      spinner.stop();
      printInfo(muted(`Paused: ${event.reason}`));
      break;
  }
}

async function confirmationPromptFn(toolName: string, input: unknown): Promise<boolean> {
  spinner.stop();
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const preview =
      typeof input === "object" && input !== null ? JSON.stringify(input).slice(0, 200) : String(input);
    rl.question(
      `  ${accent(toolName)} ${muted(preview)}\n  ${muted("approve?")} [y/N] `,
      (ans) => {
        rl.close();
        const t = ans.trim().toLowerCase();
        resolve(t === "y" || t === "yes");
      },
    );
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
      printHelp();
      break;
    }
    case "compact": {
      const turn = getCurrentTurn(db);
      const summary =
        argRest.length > 0 ? argRest : "[Compaction via /compact — summarize earlier turns in subsequent context]";
      compactConversation(db, turn, summary);
      printInfo(muted(`  Compaction marker recorded through turn ${String(turn)}.`));
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
        printInfo("  No hits.");
        break;
      }
      for (const r of hits) {
        process.stdout.write(
          `\n  ${accent(r.path)}:${String(r.startLine)}-${String(r.endLine)} ${muted(`(score: ${r.score.toFixed(2)})`)}\n`,
        );
        process.stdout.write(`  ${muted("─".repeat(40))}\n`);
        const lines = r.chunkText.split("\n");
        for (const ln of lines.slice(0, 6)) process.stdout.write(`  ${ln}\n`);
        if (lines.length > 6) process.stdout.write(`${muted("  ...")}\n`);
      }
      process.stdout.write("\n");
      break;
    }
    case "index": {
      const idxSpinner = new Spinner();
      idxSpinner.start("Indexing...");
      const result = indexCodebase(db, repoPath);
      idxSpinner.stop();
      process.stdout.write(
        `  ${success("✔")} Indexed ${String(result.filesScanned)} files, ${String(result.chunksCreated)} chunks in ${(result.elapsedMs / 1000).toFixed(1)}s\n`,
      );
      break;
    }
    case "cost": {
      const m = getSessionMetrics(db);
      const parts = [
        `${String(m.totalTurns)} turns`,
        `${String(m.totalInputTokens)} in`,
        `${String(m.totalOutputTokens)} out`,
        `${String(m.totalToolCalls)} tools`,
        `$${m.totalCostUsd.toFixed(4)}`,
      ];
      printInfo(`  ${parts.join(` ${muted("·")} `)}`);
      break;
    }
    case "status": {
      const st = getIndexStatus(db);
      const m = getSessionMetrics(db);
      printInfo(`  ${muted("index")}    ${String(st.totalFiles)} files, ${String(st.totalChunks)} chunks`);
      printInfo(`  ${muted("session")}  ${String(m.totalTurns)} turns, $${m.totalCostUsd.toFixed(4)}`);
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

        const workspace = openWorkspace(repoPath);
        const db = openSession(repoPath, {
          session: opts.session,
          forceNew: Boolean(opts.new),
          workspace,
        });

        if (opts.index !== false && config.autoIndex) {
          const status = getIndexStatus(db);
          const isInitial = status.totalChunks === 0;
          if (isInitial) {
            const idxSpinner = new Spinner();
            idxSpinner.start("Building initial code index...");
            const result = indexCodebase(db, repoPath);
            idxSpinner.stop();
            process.stdout.write(
              `  ${success("✔")} Indexed ${String(result.filesScanned)} files, ${String(result.chunksCreated)} chunks in ${(result.elapsedMs / 1000).toFixed(1)}s\n`,
            );
          } else {
            const result = indexCodebase(db, repoPath);
            if (result.filesChanged > 0) {
              printDebug(
                `Index refreshed: ${String(result.filesChanged)} files updated, ${String(result.chunksCreated)} chunks in ${(result.elapsedMs / 1000).toFixed(1)}s`,
              );
            } else {
              printDebug(`Index: ${String(status.totalChunks)} chunks from ${String(status.totalFiles)} files (up to date)`);
            }
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

        const bundledSkillsDir = path.resolve(import.meta.dir, "../../../../packages/agent/skills/bundled");
        const userSkillsDir = path.join(repoPath, ".gents", "skills");
        scanSkillDirs(db, [
          { dir: bundledSkillsDir, source: "builtin" },
          { dir: userSkillsDir, source: "user" },
        ]);

        const prompt = createDefaultPrompt(toolDefs);

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
          spinner.stop();
          rl.close();
          try { closeWorkspaceDB(workspace); } catch { /* best effort */ }
          process.exit(code ?? 0);
        };

        rl.on("close", () => {
          printInfo(muted("\n  🎩 Goodbye."));
        });

        process.once("SIGINT", () => {
          spinner.stop();
          process.stdout.write("\n");
          shutdown(130);
        });

        printBanner({
          version: "0.1.0",
          session: opts.session,
          model: config.model,
          repoPath,
        });

        let busy = false;

        const promptUser = (): void => {
          rl.question(`\n  ${accent("❯")} `, (input: string) => {
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
                printInfo("  Still processing the previous message. Please wait.");
                promptUser();
                return;
              }

              busy = true;
              printTurnSeparator();
              process.stdout.write("\n");
              try {
                for await (const event of loop.run(db, trimmed)) {
                  handleLoopEvent(event);
                }
              } catch (e) {
                spinner.stop();
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
