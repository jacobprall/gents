export type { OtelConfig } from "./types";
export {
  initTelemetry,
  traced,
  tracedAsync,
  withSpan,
  recordTokenUsage,
  recordCost,
  recordToolCall,
  recordSearchLatency,
} from "./telemetry";
