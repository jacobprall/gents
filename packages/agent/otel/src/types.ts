import type { Attributes } from "@opentelemetry/api";

export interface OtelConfig {
  serviceName?: string;
  enabled?: boolean;
}

export interface SpanHandle {
  end: (err?: Error) => void;
  setAttributes: (attrs: Attributes) => void;
}
