import type { Hook, HookResult, RedactorConfig } from "./types";

const DEFAULT_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /ghs_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9\-_]{20,}/g,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /xox[bpors]-[a-zA-Z0-9\-]{10,}/g,
];

function applyPatterns(text: string, patterns: RegExp[], replacement: string): string {
  let out = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function credentialRedactor(config?: RedactorConfig): Hook {
  const patterns = config?.patterns ?? DEFAULT_PATTERNS;
  const replacement = config?.replacement ?? "[REDACTED]";
  return {
    name: "credential-redactor",
    async postTool(
      _ctx,
      _toolName,
      output: string
    ): Promise<HookResult> {
      const redacted = applyPatterns(output, patterns, replacement);
      return { action: "continue", transformed: redacted };
    },
  };
}
