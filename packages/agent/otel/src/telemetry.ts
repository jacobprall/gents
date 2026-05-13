import {
  trace,
  metrics,
  SpanStatusCode,
  type Tracer,
  type Meter,
  type Span,
  type Counter,
  type Histogram,
  type Attributes,
} from "@opentelemetry/api";
import type { OtelConfig, SpanHandle } from "./types";

const MAX_ATTR_VALUE_LENGTH = 256;

function sanitizeAttr(value: string): string {
  return value.length > MAX_ATTR_VALUE_LENGTH
    ? value.slice(0, MAX_ATTR_VALUE_LENGTH)
    : value;
}

function endSpanWithError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.end();
}

export class TelemetryService {
  private _tracer: Tracer | null = null;
  private _meter: Meter | null = null;
  private _enabled = false;
  private _tokenCounter: Counter | null = null;
  private _costCounter: Counter | null = null;
  private _toolHistogram: Histogram | null = null;
  private _searchHistogram: Histogram | null = null;

  get enabled(): boolean {
    return this._enabled;
  }

  init(config?: OtelConfig): void {
    this._enabled = config?.enabled === true;

    if (this._enabled) {
      const name = config?.serviceName ?? "gents";
      this._tracer = trace.getTracer(name);
      this._meter = metrics.getMeter(name);
      this._tokenCounter = this._meter.createCounter("gents.tokens.total");
      this._costCounter = this._meter.createCounter("gents.cost.usd");
      this._toolHistogram = this._meter.createHistogram("gents.tool.duration_ms");
      this._searchHistogram = this._meter.createHistogram("gents.search.duration_ms");
    } else {
      this._nullify();
    }
  }

  shutdown(): void {
    this._enabled = false;
    this._nullify();
  }

  private _nullify(): void {
    this._tracer = null;
    this._meter = null;
    this._tokenCounter = null;
    this._costCounter = null;
    this._toolHistogram = null;
    this._searchHistogram = null;
  }

  traced<T>(name: string, fn: () => T): T {
    if (!this._enabled || !this._tracer) return fn();
    return this._tracer.startActiveSpan(name, (span: Span) => {
      try {
        const result = fn();
        span.end();
        return result;
      } catch (err) {
        endSpanWithError(span, err);
        throw err;
      }
    });
  }

  async tracedAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this._enabled || !this._tracer) return fn();
    return this._tracer.startActiveSpan(name, async (span: Span) => {
      try {
        const result = await fn();
        span.end();
        return result;
      } catch (err) {
        endSpanWithError(span, err);
        throw err;
      }
    });
  }

  withSpan(name: string, attributes?: Attributes): SpanHandle {
    if (!this._enabled || !this._tracer) {
      return { end: () => {}, setAttributes: () => {} };
    }
    const span = this._tracer.startSpan(name, { attributes });
    return {
      end: (err?: Error) => {
        if (err) {
          endSpanWithError(span, err);
        } else {
          span.end();
        }
      },
      setAttributes: (attrs: Attributes) => span.setAttributes(attrs),
    };
  }

  recordTokenUsage(model: string, tokensIn: number, tokensOut: number): void {
    if (!this._enabled || !this._tokenCounter) return;
    const safeModel = sanitizeAttr(model);
    this._tokenCounter.add(tokensIn, { model: safeModel, direction: "input" });
    this._tokenCounter.add(tokensOut, { model: safeModel, direction: "output" });
  }

  recordCost(model: string, costUsd: number): void {
    if (!this._enabled || !this._costCounter) return;
    this._costCounter.add(costUsd, { model: sanitizeAttr(model) });
  }

  recordToolCall(toolName: string, durationMs: number, success: boolean): void {
    if (!this._enabled || !this._toolHistogram) return;
    this._toolHistogram.record(durationMs, {
      tool: sanitizeAttr(toolName),
      success: String(success),
    });
  }

  recordSearchLatency(searchType: string, durationMs: number): void {
    if (!this._enabled || !this._searchHistogram) return;
    this._searchHistogram.record(durationMs, {
      type: sanitizeAttr(searchType),
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton instance & module-level convenience functions
// ---------------------------------------------------------------------------

let _instance = new TelemetryService();

export function initTelemetry(config?: OtelConfig): void {
  _instance.init(config);
}

export function shutdownTelemetry(): void {
  _instance.shutdown();
}

/** Replace the singleton with a fresh instance. Useful in tests. */
export function resetTelemetry(): void {
  _instance.shutdown();
  _instance = new TelemetryService();
}

export function traced<T>(name: string, fn: () => T): T {
  return _instance.traced(name, fn);
}

export async function tracedAsync<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return _instance.tracedAsync(name, fn);
}

export function withSpan(name: string, attributes?: Attributes): SpanHandle {
  return _instance.withSpan(name, attributes);
}

export function recordTokenUsage(
  model: string,
  tokensIn: number,
  tokensOut: number,
): void {
  _instance.recordTokenUsage(model, tokensIn, tokensOut);
}

export function recordCost(model: string, costUsd: number): void {
  _instance.recordCost(model, costUsd);
}

export function recordToolCall(
  toolName: string,
  durationMs: number,
  success: boolean,
): void {
  _instance.recordToolCall(toolName, durationMs, success);
}

export function recordSearchLatency(
  searchType: string,
  durationMs: number,
): void {
  _instance.recordSearchLatency(searchType, durationMs);
}
