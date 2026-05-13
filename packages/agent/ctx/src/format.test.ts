import { describe, it, expect } from "bun:test";
import { formatConversation, normalizeToBlocks } from "./format";

describe("normalizeToBlocks", () => {
  it("converts non-empty string to a single text block", () => {
    const result = normalizeToBlocks("hello");
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("returns empty array for empty string", () => {
    expect(normalizeToBlocks("")).toEqual([]);
  });

  it("preserves ContentBlock array with cache_control", () => {
    const blocks = [
      { type: "text" as const, text: "a" },
      { type: "text" as const, text: "b", cache_control: { type: "ephemeral" as const } },
    ];
    const result = normalizeToBlocks(blocks);
    expect(result).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("creates new objects (does not return same references)", () => {
    const block = { type: "text" as const, text: "a" };
    const result = normalizeToBlocks([block]);
    expect(result[0]).not.toBe(block);
    expect(result[0]).toEqual({ type: "text", text: "a" });
  });
});

describe("formatConversation", () => {
  it("returns empty array for non-array input", () => {
    expect(formatConversation(null)).toEqual([]);
    expect(formatConversation(undefined)).toEqual([]);
    expect(formatConversation("string")).toEqual([]);
    expect(formatConversation(42)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(formatConversation([])).toEqual([]);
  });

  it("formats user messages", () => {
    const result = formatConversation([{ role: "user", content: "hello" }]);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("formats assistant text-only messages", () => {
    const result = formatConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
    ]);
  });

  it("drops assistant messages with no content and no tool calls", () => {
    const result = formatConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "hello again" },
    ]);
    // Empty assistant is dropped; consecutive users are coalesced
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
  });

  it("formats assistant messages with Anthropic-style tool calls", () => {
    const toolCalls = JSON.stringify([
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "foo.ts" } },
    ]);
    const result = formatConversation([
      { role: "user", content: "read foo" },
      { role: "assistant", content: "Sure", toolCalls },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    const content = result[1]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "Sure" });
      expect(content[1]).toEqual({
        type: "tool_use",
        id: "call_1",
        name: "read_file",
        input: { path: "foo.ts" },
      });
    }
  });

  it("formats assistant messages with OpenAI-style tool calls", () => {
    const toolCalls = JSON.stringify([
      { id: "call_abc", function: { name: "grep", arguments: '{"pattern":"foo"}' } },
    ]);
    const result = formatConversation([
      { role: "user", content: "search" },
      { role: "assistant", content: "", toolCalls },
    ]);
    expect(result).toHaveLength(2);
    const content = result[1]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({
        type: "tool_use",
        id: "call_abc",
        name: "grep",
        input: { pattern: "foo" },
      });
    }
  });

  it("generates fallback IDs for tool_use blocks with missing IDs", () => {
    const toolCalls = JSON.stringify([
      { type: "tool_use", name: "read_file", input: {} },
    ]);
    const result = formatConversation([
      { role: "user", content: "go" },
      { role: "assistant", toolCalls },
    ]);
    expect(result).toHaveLength(2);
    const content = result[1]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0]).toHaveProperty("id", "call_0");
    }
  });

  it("groups consecutive tool results into a single user message", () => {
    const result = formatConversation([
      { role: "user", content: "do stuff" },
      {
        role: "assistant",
        content: "ok",
        toolCalls: JSON.stringify([
          { type: "tool_use", id: "c1", name: "a", input: {} },
          { type: "tool_use", id: "c2", name: "b", input: {} },
        ]),
      },
      { role: "tool", toolCallId: "c1", content: "result1" },
      { role: "tool", toolCallId: "c2", content: "result2" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[2]!.role).toBe("user");
    const content = result[2]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "tool_result", tool_use_id: "c1", content: "result1" });
      expect(content[1]).toEqual({ type: "tool_result", tool_use_id: "c2", content: "result2" });
    }
  });

  it("formats system compaction summaries as user messages", () => {
    const result = formatConversation([
      { role: "system", content: "Previous conversation summary" },
      { role: "assistant", content: "acknowledged" },
      { role: "user", content: "continue" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toBe("[Context compaction summary]\n\nPrevious conversation summary");
  });

  it("coalesces consecutive user messages", () => {
    const result = formatConversation([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
    const content = result[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content).toEqual([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]);
    }
  });

  it("coalesces tool results followed by user message into one user turn", () => {
    const result = formatConversation([
      { role: "user", content: "step 1" },
      {
        role: "assistant",
        content: "calling tool",
        toolCalls: JSON.stringify([{ type: "tool_use", id: "c1", name: "a", input: {} }]),
      },
      { role: "tool", toolCallId: "c1", content: "result" },
      { role: "user", content: "step 2" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[2]!.role).toBe("user");
    expect(Array.isArray(result[2]!.content)).toBe(true);
  });

  it("skips items that are not valid messages", () => {
    const result = formatConversation([
      null,
      42,
      "not an object",
      { notRole: true },
      { role: 123 },
      { role: "user", content: "valid" },
    ]);
    expect(result).toEqual([{ role: "user", content: "valid" }]);
  });

  it("handles malformed tool calls JSON gracefully", () => {
    const result = formatConversation([
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", toolCalls: "not valid json{{{" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]!.content).toBe("ok");
  });

  it("handles tool results with missing toolCallId", () => {
    const result = formatConversation([
      { role: "user", content: "go" },
      {
        role: "assistant",
        toolCalls: JSON.stringify([{ type: "tool_use", id: "c1", name: "a", input: {} }]),
      },
      { role: "tool", content: "result" },
    ]);
    expect(result).toHaveLength(3);
    const content = result[2]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "unknown_tool_use",
        content: "result",
      });
    }
  });

  it("handles empty compaction summary", () => {
    const result = formatConversation([
      { role: "system", content: "" },
      { role: "assistant", content: "ok" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("[Context compaction summary]");
  });

  it("coerces non-string user content to string", () => {
    const result = formatConversation([
      { role: "user", content: 42 },
      { role: "assistant", content: "reply" },
    ]);
    expect(result[0]!.content).toBe("42");
  });
});
