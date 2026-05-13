export type { OtelConfig, SpanHandle } from "./types";
export {
  TelemetryService,
  initTelemetry,
  shutdownTelemetry,
  resetTelemetry,
  traced,
  tracedAsync,
  withSpan,
  recordTokenUsage,
  recordCost,
  recordToolCall,
  recordSearchLatency,
} from "./telemetry";
