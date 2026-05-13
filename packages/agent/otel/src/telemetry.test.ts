import { describe, it, expect, beforeEach } from "bun:test";
import {
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

// ---------------------------------------------------------------------------
// TelemetryService (class API)
// ---------------------------------------------------------------------------

describe("TelemetryService", () => {
  let svc: TelemetryService;

  beforeEach(() => {
    svc = new TelemetryService();
  });

  describe("init", () => {
    it("defaults to disabled when called with no args", () => {
      svc.init();
      expect(svc.enabled).toBe(false);
    });

    it("defaults to disabled when called with empty config", () => {
      svc.init({});
      expect(svc.enabled).toBe(false);
    });

    it("defaults to disabled when enabled is undefined", () => {
      svc.init({ serviceName: "test" });
      expect(svc.enabled).toBe(false);
    });

    it("enables when enabled is explicitly true", () => {
      svc.init({ enabled: true });
      expect(svc.enabled).toBe(true);
    });

    it("disables when enabled is explicitly false", () => {
      svc.init({ enabled: false });
      expect(svc.enabled).toBe(false);
    });
  });

  describe("shutdown", () => {
    it("disables an enabled service", () => {
      svc.init({ enabled: true });
      expect(svc.enabled).toBe(true);
      svc.shutdown();
      expect(svc.enabled).toBe(false);
    });

    it("is safe to call when already disabled", () => {
      svc.shutdown();
      expect(svc.enabled).toBe(false);
    });
  });

  describe("traced", () => {
    it("returns the function result when disabled", () => {
      const result = svc.traced("op", () => 42);
      expect(result).toBe(42);
    });

    it("returns the function result when enabled", () => {
      svc.init({ enabled: true });
      const result = svc.traced("op", () => 42);
      expect(result).toBe(42);
    });

    it("propagates errors when disabled", () => {
      expect(() =>
        svc.traced("op", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
    });

    it("propagates errors when enabled", () => {
      svc.init({ enabled: true });
      expect(() =>
        svc.traced("op", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
    });

    it("propagates non-Error throwables when enabled", () => {
      svc.init({ enabled: true });
      expect(() =>
        svc.traced("op", () => {
          throw "string error";
        }),
      ).toThrow("string error");
    });
  });

  describe("tracedAsync", () => {
    it("returns the function result when disabled", async () => {
      const result = await svc.tracedAsync("op", async () => 42);
      expect(result).toBe(42);
    });

    it("returns the function result when enabled", async () => {
      svc.init({ enabled: true });
      const result = await svc.tracedAsync("op", async () => 42);
      expect(result).toBe(42);
    });

    it("propagates errors when disabled", async () => {
      await expect(
        svc.tracedAsync("op", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });

    it("propagates errors when enabled", async () => {
      svc.init({ enabled: true });
      await expect(
        svc.tracedAsync("op", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });
  });

  describe("withSpan", () => {
    it("returns a no-op handle when disabled", () => {
      const handle = svc.withSpan("op");
      expect(handle.end).toBeFunction();
      expect(handle.setAttributes).toBeFunction();
      handle.end();
      handle.setAttributes({ key: "val" });
    });

    it("returns a functional handle when enabled", () => {
      svc.init({ enabled: true });
      const handle = svc.withSpan("op", { key: "val" });
      expect(handle.end).toBeFunction();
      expect(handle.setAttributes).toBeFunction();
      handle.end();
    });

    it("accepts an error on end without throwing", () => {
      svc.init({ enabled: true });
      const handle = svc.withSpan("op");
      handle.end(new Error("failed"));
    });
  });

  describe("record helpers (no-op when disabled)", () => {
    it("recordTokenUsage does not throw when disabled", () => {
      expect(() => svc.recordTokenUsage("model", 100, 50)).not.toThrow();
    });

    it("recordCost does not throw when disabled", () => {
      expect(() => svc.recordCost("model", 0.01)).not.toThrow();
    });

    it("recordToolCall does not throw when disabled", () => {
      expect(() => svc.recordToolCall("tool", 123, true)).not.toThrow();
    });

    it("recordSearchLatency does not throw when disabled", () => {
      expect(() => svc.recordSearchLatency("bm25", 45)).not.toThrow();
    });
  });

  describe("record helpers (enabled)", () => {
    beforeEach(() => svc.init({ enabled: true }));

    it("recordTokenUsage does not throw", () => {
      expect(() => svc.recordTokenUsage("model", 100, 50)).not.toThrow();
    });

    it("recordCost does not throw", () => {
      expect(() => svc.recordCost("model", 0.01)).not.toThrow();
    });

    it("recordToolCall does not throw", () => {
      expect(() => svc.recordToolCall("tool", 123, true)).not.toThrow();
    });

    it("recordToolCall records failures", () => {
      expect(() => svc.recordToolCall("tool", 123, false)).not.toThrow();
    });

    it("recordSearchLatency does not throw", () => {
      expect(() => svc.recordSearchLatency("bm25", 45)).not.toThrow();
    });

    it("truncates overly long attribute values", () => {
      const longName = "x".repeat(1000);
      expect(() => svc.recordToolCall(longName, 1, true)).not.toThrow();
      expect(() => svc.recordTokenUsage(longName, 1, 1)).not.toThrow();
      expect(() => svc.recordCost(longName, 0.01)).not.toThrow();
      expect(() => svc.recordSearchLatency(longName, 1)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Module-level convenience functions
// ---------------------------------------------------------------------------

describe("module-level functions", () => {
  beforeEach(() => resetTelemetry());

  describe("initTelemetry / shutdownTelemetry / resetTelemetry", () => {
    it("initTelemetry with no args keeps telemetry disabled", () => {
      initTelemetry();
      expect(() => recordTokenUsage("m", 1, 1)).not.toThrow();
    });

    it("shutdownTelemetry is safe to call multiple times", () => {
      initTelemetry({ enabled: true });
      shutdownTelemetry();
      shutdownTelemetry();
    });

    it("resetTelemetry creates a clean state", () => {
      initTelemetry({ enabled: true });
      resetTelemetry();
      const result = traced("op", () => 99);
      expect(result).toBe(99);
    });
  });

  describe("traced / tracedAsync", () => {
    it("traced passes through return values", () => {
      expect(traced("op", () => "hello")).toBe("hello");
    });

    it("tracedAsync passes through return values", async () => {
      expect(await tracedAsync("op", async () => "hello")).toBe("hello");
    });
  });

  describe("withSpan", () => {
    it("returns a handle with end and setAttributes", () => {
      const h = withSpan("op");
      expect(h.end).toBeFunction();
      expect(h.setAttributes).toBeFunction();
      h.end();
    });
  });

  describe("record helpers", () => {
    it("all record functions are callable when disabled", () => {
      expect(() => recordTokenUsage("m", 1, 1)).not.toThrow();
      expect(() => recordCost("m", 0.01)).not.toThrow();
      expect(() => recordToolCall("t", 1, true)).not.toThrow();
      expect(() => recordSearchLatency("s", 1)).not.toThrow();
    });

    it("all record functions are callable when enabled", () => {
      initTelemetry({ enabled: true });
      expect(() => recordTokenUsage("m", 1, 1)).not.toThrow();
      expect(() => recordCost("m", 0.01)).not.toThrow();
      expect(() => recordToolCall("t", 1, true)).not.toThrow();
      expect(() => recordSearchLatency("s", 1)).not.toThrow();
    });
  });
});
