import type {
  Hook,
  HookContext,
  PostHookResult,
  PreHookResult,
  RedactorConfig,
} from "./types";

const DEFAULT_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /ghs_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9\-_]{20,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /xox[bpors]-[a-zA-Z0-9\-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /npm_[a-zA-Z0-9]{36}/g,
  /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|amqp):\/\/[^\s:]+:[^\s@]+@[^\s"']+/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
];

function compilePatterns(patterns: RegExp[]): RegExp[] {
  return patterns.map((p) => new RegExp(p.source, p.flags));
}

function applyPatterns(
  text: string,
  compiled: RegExp[],
  replacement: string,
): string {
  let out = text;
  for (const re of compiled) {
    out = out.replace(re, replacement);
  }
  return out;
}

function redactObject(
  obj: unknown,
  compiled: RegExp[],
  replacement: string,
): void {
  if (typeof obj !== "object" || obj === null) return;
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (typeof val === "string") {
      record[key] = applyPatterns(val, compiled, replacement);
    } else if (typeof val === "object" && val !== null) {
      redactObject(val, compiled, replacement);
    }
  }
}

export function credentialRedactor(config?: RedactorConfig): Hook {
  const compiled = compilePatterns(config?.patterns ?? DEFAULT_PATTERNS);
  const replacement = config?.replacement ?? "[REDACTED]";

  function redact(text: string): PostHookResult {
    const redacted = applyPatterns(text, compiled, replacement);
    return redacted === text
      ? { action: "continue" }
      : { action: "continue", transformed: redacted };
  }

  return {
    name: "credential-redactor",
    async preLLM(_ctx: HookContext): Promise<PreHookResult> {
      return { action: "continue" };
    },
    async postLLM(
      _ctx: HookContext,
      responseText: string,
    ): Promise<PostHookResult> {
      return redact(responseText);
    },
    async preTool(
      _ctx: HookContext,
      _toolName: string,
      input: unknown,
    ): Promise<PreHookResult> {
      redactObject(input, compiled, replacement);
      return { action: "continue" };
    },
    async postTool(
      _ctx: HookContext,
      _toolName: string,
      output: string,
    ): Promise<PostHookResult> {
      return redact(output);
    },
  };
}
