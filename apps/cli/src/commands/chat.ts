import { createAgentLoop, createChildLoopFactory, inferProvider, type LoopEvent, type ProviderName } from "@gents/agent-loop";
import {
  closeAgentDB,
  closeWorkspaceDB,
  compactConversation,
  createSession,
  discoverBlueprints,
  getConfig,
  getCurrentTurn,
  getIndexStatus,
  getPermissions,
  getSessionMetrics,
  hybridSearch,
  indexCodebase,
  listSessions,
  getActiveSession,
  scanSkillDirs,
  setActiveSession,
  type AgentBlueprint,
  type AgentDB,
  type Permission,
  type SessionSummary,
} from "@gents/agent-db";
import {
  confirmationGate,
  createHookPipeline,
  credentialRedactor,
  toolGovernance,
  type GovernanceConfig,
} from "@gents/agent-hooks";
import { createToolRegistry, registerBuiltinTools } from "@gents/agent-tools";
import { Command } from "commander";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  accent,
  bold,
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
import { listAgents, openAgent, openWorkspace, type AgentInfo } from "../session";

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

function permissionsToGovernance(permissions: Permission[]): GovernanceConfig {
  const allowedTools: string[] = [];
  const deniedTools: string[] = [];
  const pathAllow: string[] = [];
  const pathDeny: string[] = [];

  for (const p of permissions) {
    switch (p.type) {
      case "tool_allow":
        allowedTools.push(p.pattern);
        break;
      case "tool_deny":
        deniedTools.push(p.pattern);
        break;
      case "path_allow":
        pathAllow.push(p.pattern);
        break;
      case "path_deny":
        pathDeny.push(p.pattern);
        break;
    }
  }

  const config: GovernanceConfig = {};
  if (allowedTools.length > 0) config.allowedTools = allowedTools;
  if (deniedTools.length > 0) config.deniedTools = deniedTools;
  if (pathAllow.length > 0 || pathDeny.length > 0) {
    config.pathRestrictions = {};
    if (pathAllow.length > 0) config.pathRestrictions.allow = pathAllow;
    if (pathDeny.length > 0) config.pathRestrictions.deny = pathDeny;
  }
  return config;
}

// ── Model catalog for /model command ────────────────────────────────

interface ModelEntry {
  id: string;
  label: string;
  provider: ProviderName;
}

const MODEL_CATALOG: ModelEntry[] = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-opus-4-20250514", label: "Claude Opus 4", provider: "anthropic" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", provider: "anthropic" },
  { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", provider: "anthropic" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai" },
  { id: "o3", label: "o3", provider: "openai" },
  { id: "o4-mini", label: "o4-mini", provider: "openai" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "google" },
];

// ── Interactive pickers ─────────────────────────────────────────────

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function timeAgo(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

async function pickBlueprint(
  rl: readline.Interface,
  repoPath: string,
): Promise<AgentBlueprint> {
  const blueprints = discoverBlueprints(repoPath);
  if (blueprints.length === 1) return blueprints[0]!;

  process.stdout.write(`\n  ${bold("Available blueprints:")}\n\n`);
  for (let i = 0; i < blueprints.length; i++) {
    const bp = blueprints[i]!;
    const desc = bp.description ? muted(bp.description) : "";
    process.stdout.write(`    ${muted(String(i + 1) + ".")} ${bp.name} ${desc}\n`);
  }

  const ans = await ask(rl, `\n  Select blueprint ${muted(`[1]`)}: `);
  const idx = parseInt(ans.trim(), 10);
  if (idx >= 1 && idx <= blueprints.length) return blueprints[idx - 1]!;
  return blueprints[0]!;
}

async function pickAgent(
  rl: readline.Interface,
  agents: AgentInfo[],
): Promise<{ action: "existing"; agent: AgentInfo } | { action: "new" }> {
  process.stdout.write(`\n  ${bold("Agents in this repo:")}\n\n`);
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    const bpLabel = a.blueprintDescription ?? a.blueprintName ?? "unknown";
    process.stdout.write(`    ${muted(String(i + 1) + ".")} ${a.name}  ${muted(bpLabel)}\n`);
  }
  process.stdout.write(`    ${muted("n.")} Create new agent\n`);

  const ans = await ask(rl, `\n  Select agent ${muted(`[1]`)}: `);
  const trimmed = ans.trim().toLowerCase();

  if (trimmed === "n" || trimmed === "new") return { action: "new" };

  const idx = parseInt(trimmed, 10);
  if (idx >= 1 && idx <= agents.length) return { action: "existing", agent: agents[idx - 1]! };
  return { action: "existing", agent: agents[0]! };
}

async function pickSession(
  rl: readline.Interface,
  sessions: SessionSummary[],
): Promise<{ action: "resume"; sessionId: string } | { action: "fresh" }> {
  if (sessions.length === 0) return { action: "fresh" };

  process.stdout.write(`\n  ${bold("Sessions:")}\n\n`);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    const label = s.label ?? muted("(unlabeled)");
    const info = `${String(s.turns)} turns ${muted("·")} $${s.costUsd.toFixed(2)} ${muted("·")} ${timeAgo(s.lastActiveAt)}`;
    process.stdout.write(`    ${muted(String(i + 1) + ".")} ${label}  ${info}\n`);
  }

  const ans = await ask(rl, `\n  ${muted("[r]esume latest, [f]resh session, or [#] to pick?")} ${muted("[r]")}: `);
  const trimmed = ans.trim().toLowerCase();

  if (trimmed === "f" || trimmed === "fresh") return { action: "fresh" };

  const idx = parseInt(trimmed, 10);
  if (idx >= 1 && idx <= sessions.length) return { action: "resume", sessionId: sessions[idx - 1]!.id };

  // Default: resume latest
  return { action: "resume", sessionId: sessions[0]!.id };
}

// ── Slash commands ──────────────────────────────────────────────────

async function handleSlashCommand(
  line: string,
  db: AgentDB,
  repoPath: string,
): Promise<{ switchModel?: { model: string; provider: ProviderName }; newSession?: boolean } | void> {
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
    case "fresh": {
      return { newSession: true };
    }
    case "sessions": {
      const sessions = listSessions(db);
      if (sessions.length === 0) {
        printInfo("  No sessions yet.");
        break;
      }
      process.stdout.write("\n");
      for (const s of sessions) {
        const label = s.label ?? "(unlabeled)";
        const active = s.id === db.activeSessionId ? accent(" ←") : "";
        const info = `${String(s.turns)} turns ${muted("·")} $${s.costUsd.toFixed(2)} ${muted("·")} ${timeAgo(s.lastActiveAt)}`;
        process.stdout.write(`  ${label}  ${info}${active}\n`);
      }
      process.stdout.write("\n");
      break;
    }
    case "agents": {
      const agents = listAgents(repoPath);
      if (agents.length === 0) {
        printInfo("  No agents.");
        break;
      }
      process.stdout.write("\n");
      for (const a of agents) {
        const bpLabel = a.blueprintDescription ?? a.blueprintName ?? "unknown";
        process.stdout.write(`  ${a.name}  ${muted(bpLabel)}\n`);
      }
      process.stdout.write("\n");
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
    const byProvider = MODEL_CATALOG.filter((m) => m.provider === argRest.toLowerCase());
    if (byProvider.length > 0 && available.includes(argRest.toLowerCase() as ProviderName)) {
      printInfo(`  Switching to ${accent(byProvider[0]!.label)} ${muted(`(${byProvider[0]!.id})`)}`);
      return { switchModel: { model: byProvider[0]!.id, provider: argRest.toLowerCase() as ProviderName } };
    }
    const inferred = inferProvider(argRest);
    printInfo(`  Switching to ${accent(argRest)}`);
    return { switchModel: { model: argRest, provider: inferred } };
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

// ── Command ─────────────────────────────────────────────────────────

export const chatCommand = new Command("chat")
  .description("Start or resume an interactive agent session")
  .argument("[message]", "Initial message to send (skips first prompt)")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--agent <name>", "Agent name (default: interactive picker)")
  .option("--session <id>", "Resume a specific session ID")
  .option("--new", "Create new agent with default blueprint + fresh session")
  .option("--model <model>", "Override model")
  .option("--provider <provider>", "LLM provider (anthropic, openai, google)")
  .option("--no-index", "Skip index freshness check")
  .option("--no-confirm", "Skip tool confirmation prompts")
  .action(
    async (message: string | undefined, opts: {
      repo: string;
      agent?: string;
      session?: string;
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

        const interactive = process.stdin.isTTY ?? false;
        const workspace = openWorkspace(repoPath);

        // ── Resolve which agent + session to use ────────────────
        let agentName = opts.agent ?? "default";
        let blueprint: AgentBlueprint | undefined;
        let startFreshSession = Boolean(opts.new);
        let explicitSessionId = opts.session;

        if (interactive && !opts.agent && !opts.new) {
          const agents = listAgents(repoPath);
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

          try {
            if (agents.length === 0) {
              blueprint = await pickBlueprint(rl, repoPath);
              agentName = blueprint.name === "gents-default" ? "default" : blueprint.name;
              startFreshSession = true;
            } else if (agents.length === 1 && agents[0]!.name === "default") {
              agentName = "default";
            } else {
              const agentChoice = await pickAgent(rl, agents);
              if (agentChoice.action === "new") {
                blueprint = await pickBlueprint(rl, repoPath);
                agentName = blueprint.name === "gents-default" ? "default" : blueprint.name;
                startFreshSession = true;
              } else {
                agentName = agentChoice.agent.name;
              }
            }

            if (!startFreshSession && !explicitSessionId) {
              const tempDb = openAgent(repoPath, { name: agentName, workspace });
              const sessions = listSessions(tempDb);
              closeAgentDB(tempDb);

              if (sessions.length > 0) {
                const sessionChoice = await pickSession(rl, sessions);
                if (sessionChoice.action === "fresh") {
                  startFreshSession = true;
                } else {
                  explicitSessionId = sessionChoice.sessionId;
                }
              } else {
                startFreshSession = true;
              }
            }
          } finally {
            rl.close();
          }
        }

        const db = openAgent(repoPath, { name: agentName, blueprint, workspace });

        // ── Resolve session ─────────────────────────────────────
        if (explicitSessionId) {
          setActiveSession(db, explicitSessionId);
        } else if (startFreshSession) {
          const session = createSession(db);
          setActiveSession(db, session.id);
          printDebug(`New session started (${session.id.slice(0, 8)})`);
        } else {
          const existing = getActiveSession(db);
          if (existing) {
            setActiveSession(db, existing.id);
          } else {
            const session = createSession(db);
            setActiveSession(db, session.id);
          }
        }

        // ── Index ───────────────────────────────────────────────
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

        // ── Build agent loop ────────────────────────────────────
        const registry = createToolRegistry();
        registerBuiltinTools(registry);
        const toolDefs = registry.listForLLM();

        const governanceConfig = permissionsToGovernance(getPermissions(db));

        const maxTurnsRaw = getConfig(db, "max_turns");
        const maxIterations =
          maxTurnsRaw != null && Number.isFinite(Number(maxTurnsRaw)) && Number(maxTurnsRaw) > 0
            ? Number(maxTurnsRaw)
            : undefined;

        const hookList = [
          credentialRedactor(),
          toolGovernance(governanceConfig),
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

        let loop = await createAgentLoop({
          model: activeModel,
          apiKey: activeApiKey,
          provider: activeProvider,
          tools: registry,
          hooks,
          ctx: prompt,
          repoPath,
          maxIterations,
          maxCostPerSession: config.maxCostPerSession,
          childLoopFactory: createChildLoopFactory({
            model: activeModel,
            apiKey: activeApiKey,
            provider: activeProvider,
            parentRegistry: registry,
          }),
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
            maxIterations,
            maxCostPerSession: config.maxCostPerSession,
            childLoopFactory: createChildLoopFactory({
              model: activeModel,
              apiKey: activeApiKey,
              provider: activeProvider,
              parentRegistry: registry,
            }),
          });
        }

        // ── Non-interactive (piped) mode ────────────────────────
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
          try {
            for await (const event of loop.run(db, piped)) {
              handleLoopEvent(event);
            }
          } catch (e) {
            printError(e instanceof Error ? e.message : String(e));
            process.exitCode = 1;
          } finally {
            try { closeAgentDB(db); } catch { /* best effort */ }
            try { closeWorkspaceDB(workspace); } catch { /* best effort */ }
          }
          process.exit(process.exitCode ?? 0);
        }

        // ── Interactive REPL ────────────────────────────────────
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        const shutdown = (code?: number): void => {
          spinner.stop();
          rl.close();
          try { closeAgentDB(db); } catch { /* best effort */ }
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
          session: db.activeSessionId?.slice(0, 8) ?? agentName,
          model: activeModel,
          provider: activeProvider,
          repoPath,
        });

        let busy = false;

        if (message) {
          busy = true;
          printTurnSeparator();
          process.stdout.write("\n");
          try {
            for await (const event of loop.run(db, message)) {
              handleLoopEvent(event);
            }
          } catch (e) {
            spinner.stop();
            printError(e instanceof Error ? e.message : String(e));
          }
          busy = false;
        }

        const promptUser = (): void => {
          rl.question(`\n  ${accent("❯")} `, (input: string) => {
            void (async () => {
              const trimmed = input.trim();
              if (!trimmed || trimmed === "/exit" || trimmed === "/quit") {
                shutdown(0);
                return;
              }

              if (trimmed.startsWith("/")) {
                try {
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
                  if (result && "newSession" in result && result.newSession) {
                    const session = createSession(db);
                    setActiveSession(db, session.id);
                    printInfo(muted(`  Fresh session started (${session.id.slice(0, 8)})`));
                  }
                } catch (e) {
                  printError(e instanceof Error ? e.message : String(e));
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
