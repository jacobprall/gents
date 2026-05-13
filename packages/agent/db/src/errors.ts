export function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}
