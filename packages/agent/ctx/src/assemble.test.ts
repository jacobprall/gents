import { describe, it, expect } from "bun:test";
import { definePrompt } from "./assemble";
import type { AgentDB } from "@gents/agent-db";
import type { AssemblyContext, ContentBlock } from "./types";

const mockDb = {} as unknown as AgentDB;
const defaultCtx: AssemblyContext = {};

describe("definePrompt", () => {
  it("assembles static sections into system blocks", async () => {
    const prompt = definePrompt({
      sections: [{ name: "intro", placement: "static", resolve: () => "Hello world" }],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system).toHaveLength(1);
    expect(result.system[0]!.text).toBe("Hello world");
  });

  it("sets cache_control on the last static block", async () => {
    const prompt = definePrompt({
      sections: [
        { name: "a", placement: "static", resolve: () => "first" },
        { name: "b", placement: "static", resolve: () => "second" },
      ],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system[0]!.cache_control).toBeUndefined();
    expect(result.system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not mutate original objects returned by resolvers", async () => {
    const sharedBlock: ContentBlock = { type: "text", text: "shared" };
    const prompt = definePrompt({
      sections: [{ name: "s", placement: "static", resolve: () => [sharedBlock] }],
    });
    await prompt.assemble(mockDb, defaultCtx);
    expect(sharedBlock.cache_control).toBeUndefined();
  });

  it("places dynamic sections after static sections in system", async () => {
    const prompt = definePrompt({
      sections: [
        { name: "dynamic1", placement: "dynamic", resolve: () => "dyn" },
        { name: "static1", placement: "static", resolve: () => "stat" },
      ],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system[0]!.text).toBe("stat");
    expect(result.system[1]!.text).toBe("dyn");
  });

  it("uses conversationResolver for messages", async () => {
    const prompt = definePrompt({
      sections: [{ name: "sys", placement: "static", resolve: () => "system" }],
      conversationResolver: () => [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[1]!.role).toBe("assistant");
  });

  it("returns empty messages when no conversationResolver is provided", async () => {
    const prompt = definePrompt({
      sections: [{ name: "s", placement: "static", resolve: () => "ok" }],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.messages).toEqual([]);
  });

  it("passes tools through from config", async () => {
    const tools = [{ name: "t", description: "d", input_schema: {} }];
    const prompt = definePrompt({ sections: [], tools });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.tools).toEqual(tools);
  });

  it("defaults tools to empty array when not provided", async () => {
    const prompt = definePrompt({ sections: [] });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.tools).toEqual([]);
  });

  it("supports async section resolvers", async () => {
    const prompt = definePrompt({
      sections: [
        {
          name: "async",
          placement: "static",
          resolve: async () => "async result",
        },
      ],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system[0]!.text).toBe("async result");
  });

  it("supports async conversationResolver", async () => {
    const prompt = definePrompt({
      sections: [],
      conversationResolver: async () => [{ role: "user", content: "async hello" }],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe("async hello");
  });

  it("preserves existing cache_control on last static block", async () => {
    const prompt = definePrompt({
      sections: [
        {
          name: "s",
          placement: "static",
          resolve: () => [
            { type: "text" as const, text: "cached", cache_control: { type: "ephemeral" as const } },
          ],
        },
      ],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("produces empty system blocks when no sections are provided", async () => {
    const prompt = definePrompt({ sections: [] });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system).toEqual([]);
  });

  it("skips empty string sections", async () => {
    const prompt = definePrompt({
      sections: [
        { name: "empty", placement: "static", resolve: () => "" },
        { name: "real", placement: "static", resolve: () => "content" },
      ],
    });
    const result = await prompt.assemble(mockDb, defaultCtx);
    expect(result.system).toHaveLength(1);
    expect(result.system[0]!.text).toBe("content");
  });

  it("passes db and context to section resolvers", async () => {
    let receivedDb: unknown;
    let receivedCtx: unknown;
    const ctx: AssemblyContext = { currentTurn: 5, metadata: { custom: true } };

    const prompt = definePrompt({
      sections: [
        {
          name: "spy",
          placement: "static",
          resolve: (db, context) => {
            receivedDb = db;
            receivedCtx = context;
            return "ok";
          },
        },
      ],
    });
    await prompt.assemble(mockDb, ctx);
    expect(receivedDb).toBe(mockDb);
    expect(receivedCtx).toBe(ctx);
  });

  it("passes db and context to conversationResolver", async () => {
    let receivedDb: unknown;
    let receivedCtx: unknown;
    const ctx: AssemblyContext = { currentTurn: 3 };

    const prompt = definePrompt({
      sections: [],
      conversationResolver: (db, context) => {
        receivedDb = db;
        receivedCtx = context;
        return [];
      },
    });
    await prompt.assemble(mockDb, ctx);
    expect(receivedDb).toBe(mockDb);
    expect(receivedCtx).toBe(ctx);
  });
});
