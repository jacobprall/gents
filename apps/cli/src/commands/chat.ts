import { createAgentLoop, createChildLoopFactory, type LoopEvent, type ProviderName } from "@gents/agent-loop";
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
import { availableProviders, resolveConfig } from "../config";
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

// ── Model catalog for /model command ────────────────────────────────

interface ModelEntry {
  id: string;
  label: string;
  provider: ProviderName;
}

const MODEL_CATALOG: ModelEntry[] = [
  // Anthropic
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-opus-4-20250514", label: "Claude Opus 4", provider: "anthropic" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", provider: "anthropic" },
  { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", provider: "anthropic" },
  // OpenAI
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai" },
  { id: "o3", label: "o3", provider: "openai" },
  { id: "o4-mini", label: "o4-mini", provider: "openai" },
  // Google
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "google" },
];

async function handleSlashCommand(
  line: string,
  db: Parameters<typeof getCurrentTurn>[0],
  repoPath: string,
): Promise<{ switchModel?: { model: string; provider: ProviderName } } | void> {
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
    case "model": {
      return handleModelCommand(argRest);
    }
    default:
      printError(`Unknown command /${cmd}. Type /help.`);
      break;
  }
}

function handleModelCommand(
  argRest: string,
): { switchModel: { model: string; provider: ProviderName } } | void {
  const available = availableProviders();

  if (argRest) {
    const exact = MODEL_CATALOG.find((m) => m.id === argRest || m.label.toLowerCase() === argRest.toLowerCase());
    if (exact) {
      if (!available.includes(exact.provider)) {
        printError(`No API key configured for ${exact.provider}. Run \`gents config set ${exact.provider}_api_key <key>\``);
        return;
      }
      printInfo(`  Switching to ${accent(exact.label)} ${muted(`(${exact.id})`)}`);
      return { switchModel: { model: exact.id, provider: exact.provider } };
    }
    const byProvider = MODEL_CATALOG.filter((m) => m.provider === argRest);
    if (byProvider.length > 0 && available.includes(argRest as ProviderName)) {
      printInfo(`  Switching to ${accent(byProvider[0]!.label)} ${muted(`(${byProvider[0]!.id})`)}`);
      return { switchModel: { model: byProvider[0]!.id, provider: argRest as ProviderName } };
    }
    // Treat as a raw model ID
    printInfo(`  Switching to ${accent(argRest)}`);
    return { switchModel: { model: argRest, provider: available[0] ?? "anthropic" } };
  }

  const filtered = MODEL_CATALOG.filter((m) => available.includes(m.provider));
  if (filtered.length === 0) {
    printError("No API keys configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY.");
    return;
  }

  process.stdout.write("\n");
  let currentProvider: ProviderName | null = null;
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]!;
    if (entry.provider !== currentProvider) {
      currentProvider = entry.provider;
      process.stdout.write(`  ${accent(currentProvider)}\n`);
    }
    process.stdout.write(`    ${muted(String(i + 1) + ".")} ${entry.label} ${muted(`(${entry.id})`)}\n`);
  }
  process.stdout.write(`\n  ${muted("Usage: /model <name|number>")}\n\n`);
}

export const chatCommand = new Command("chat")
  .description("Start or resume an interactive agent session")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .option("--new", "Force new session")
  .option("--model <model>", "Override model")
  .option("--provider <provider>", "LLM provider (anthropic, openai, google)")
  .option("--no-index", "Skip index freshness check")
  .option("--no-confirm", "Skip tool confirmation prompts")
  .action(
    async (opts: {
      repo: string;
      session: string;
      new?: boolean;
      model?: string;
      provider?: string;
      index?: boolean;
      confirm?: boolean;
    }) => {
      try {
        const repoPath = path.resolve(opts.repo);
        const config = resolveConfig({
          model: opts.model,
          provider: opts.provider as ProviderName | undefined,
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

        let activeModel = config.model;
        let activeProvider = config.provider;
        let activeApiKey = config.apiKey;

        const childLoopFactory = createChildLoopFactory({
          model: activeModel,
          apiKey: activeApiKey,
          provider: activeProvider,
          parentRegistry: registry,
        });

        let loop = await createAgentLoop({
          model: activeModel,
          apiKey: activeApiKey,
          provider: activeProvider,
          tools: registry,
          hooks,
          ctx: prompt,
          repoPath,
          maxCostPerSession: config.maxCostPerSession,
          childLoopFactory,
        });

        async function rebuildLoop(): Promise<void> {
          loop = await createAgentLoop({
            model: activeModel,
            apiKey: activeApiKey,
            provider: activeProvider,
            tools: registry,
            hooks,
            ctx: prompt,
            repoPath,
            maxCostPerSession: config.maxCostPerSession,
            childLoopFactory: createChildLoopFactory({
              model: activeModel,
              apiKey: activeApiKey,
              provider: activeProvider,
              parentRegistry: registry,
            }),
          });
        }

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
          model: activeModel,
          provider: activeProvider,
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
                const result = await handleSlashCommand(trimmed, db, repoPath);
                if (result && "switchModel" in result && result.switchModel) {
                  const { model: newModel, provider: newProv } = result.switchModel;
                  try {
                    const newConfig = resolveConfig({
                      model: newModel,
                      provider: newProv,
                    });
                    activeModel = newConfig.model;
                    activeProvider = newConfig.provider;
                    activeApiKey = newConfig.apiKey;
                    await rebuildLoop();
                    printInfo(muted(`  Now using ${activeModel} via ${activeProvider}`));
                  } catch (e) {
                    printError(e instanceof Error ? e.message : String(e));
                  }
                }
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
