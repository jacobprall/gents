import type { Hook, HookContext, PostHookResult, RedactorConfig } from "./types";

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

interface PatternSource {
  source: string;
  flags: string;
}

function toSources(patterns: RegExp[]): PatternSource[] {
  return patterns.map((p) => ({ source: p.source, flags: p.flags }));
}

function applyPatterns(
  text: string,
  sources: PatternSource[],
  replacement: string,
): string {
  let out = text;
  for (const { source, flags } of sources) {
    out = out.replace(new RegExp(source, flags), replacement);
  }
  return out;
}

export function credentialRedactor(config?: RedactorConfig): Hook {
  const sources = toSources(config?.patterns ?? DEFAULT_PATTERNS);
  const replacement = config?.replacement ?? "[REDACTED]";

  function redact(text: string): PostHookResult {
    const redacted = applyPatterns(text, sources, replacement);
    return redacted === text
      ? { action: "continue" }
      : { action: "continue", transformed: redacted };
  }

  return {
    name: "credential-redactor",
    async postLLM(
      _ctx: HookContext,
      responseText: string,
    ): Promise<PostHookResult> {
      return redact(responseText);
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
