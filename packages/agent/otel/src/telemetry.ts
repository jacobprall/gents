import { trace, metrics, type Tracer, type Meter, type Span, type Counter, type Histogram } from "@opentelemetry/api";
import type { OtelConfig } from "./types";

let _tracer: Tracer | null = null;
let _meter: Meter | null = null;
let _enabled = false;

let _tokenCounter: Counter | null = null;
let _costCounter: Counter | null = null;
let _toolHistogram: Histogram | null = null;
let _searchHistogram: Histogram | null = null;

export function initTelemetry(config?: OtelConfig): void {
  _enabled = config?.enabled !== false;
  if (_enabled) {
    const name = config?.serviceName ?? "gents";
    _tracer = trace.getTracer(name);
    _meter = metrics.getMeter(name);
    _tokenCounter = _meter.createCounter("gents.tokens.total");
    _costCounter = _meter.createCounter("gents.cost.usd");
    _toolHistogram = _meter.createHistogram("gents.tool.duration_ms");
    _searchHistogram = _meter.createHistogram("gents.search.duration_ms");
  } else {
    _tracer = null;
    _meter = null;
    _tokenCounter = null;
    _costCounter = null;
    _toolHistogram = null;
    _searchHistogram = null;
  }
}

export function traced<T>(name: string, fn: () => T): T {
  if (!_enabled || !_tracer) return fn();
  return _tracer.startActiveSpan(name, (span: Span) => {
    try {
      const result = fn();
      span.end();
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.end();
      throw err;
    }
  });
}

export async function tracedAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!_enabled || !_tracer) return fn();
  return _tracer.startActiveSpan(name, async (span: Span) => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.end();
      throw err;
    }
  });
}

export function withSpan(
  name: string,
  attributes?: Record<string, string>
): { end: () => void } {
  if (!_enabled || !_tracer) return { end: () => {} };
  const span = _tracer.startSpan(name, { attributes });
  return { end: () => span.end() };
}

export function recordTokenUsage(model: string, tokensIn: number, tokensOut: number): void {
  if (!_enabled || !_tokenCounter) return;
  _tokenCounter.add(tokensIn, { model, direction: "input" });
  _tokenCounter.add(tokensOut, { model, direction: "output" });
}

export function recordCost(model: string, costUsd: number): void {
  if (!_enabled || !_costCounter) return;
  _costCounter.add(costUsd, { model });
}

export function recordToolCall(toolName: string, durationMs: number, success: boolean): void {
  if (!_enabled || !_toolHistogram) return;
  _toolHistogram.record(durationMs, { tool: toolName, success: String(success) });
}

export function recordSearchLatency(searchType: string, durationMs: number): void {
  if (!_enabled || !_searchHistogram) return;
  _searchHistogram.record(durationMs, { type: searchType });
}
