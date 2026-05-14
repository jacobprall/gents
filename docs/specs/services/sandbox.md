# SandboxService (`services/sandbox`)

**Status:** Proposed
**Package:** `@gents/sandbox`
**Depends on:** E2B SDK, Docker (local dev), Fly Machines API (future)

---

## Purpose

The SandboxService provisions and manages isolated execution environments where agents run code. When a workflow starts, the runner asks the SandboxService for a sandbox — a containerized environment with a filesystem, shell access, and network — then uses that sandbox to clone the repo, run tools, execute tests, and produce artifacts.

The service uses a provider/adapter pattern: the interface is stable, and the underlying provider (E2B for production, Docker for local dev, Fly for scale) can be swapped via a factory function without changing callers.

---

## File Layout

```
services/sandbox/
  src/
    index.ts                 # barrel exports + factory re-export
    types.ts                 # SandboxService, Sandbox, SandboxConfig interfaces
    providers/
      e2b.ts                 # E2BSandboxService
      fly.ts                 # FlySandboxService (future)
      docker.ts              # DockerSandboxService (local dev)
    factory.ts               # createSandboxService(provider, config)
  package.json
  tsconfig.json
```

---

## Interface

### SandboxService (Lifecycle Manager)

```typescript
export interface SandboxService {
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;
  get(sandboxId: string): Promise<Sandbox | null>;
  list(): Promise<{ id: string; status: string; createdAt: Date }[]>;
}
```

| Method | Description |
|---|---|
| `create` | Provision a new sandbox with the given config. Returns when the sandbox is ready for use. |
| `destroy` | Tear down a sandbox and release all resources. Idempotent. |
| `get` | Reconnect to an existing sandbox by ID. Returns `null` if the sandbox no longer exists. |
| `list` | List all active sandboxes managed by this service instance. |

### SandboxConfig

```typescript
export interface SandboxConfig {
  image?: string;                     // container image (provider-specific default if omitted)
  timeout: number;                    // sandbox lifetime in minutes
  resources?: { cpu?: string; memory?: string };
  env?: Record<string, string>;       // environment variables injected at creation
  ports?: number[];                   // ports to expose for preview URLs
}
```

### Sandbox (Runtime Handle)

```typescript
export interface Sandbox {
  id: string;
  status: "creating" | "ready" | "running" | "stopped";
  url: string;

  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string, opts?: { recursive?: boolean }): Promise<DirEntry[]>;
  uploadFiles(files: FileUpload[]): Promise<void>;
  downloadFiles(paths: string[]): Promise<FileDownload[]>;

  getHost(port: number): string;
  keepAlive(durationMs: number): Promise<void>;
}
```

### Supporting Types

```typescript
export interface ExecOpts {
  cwd?: string;
  timeout?: number;                   // seconds
  env?: Record<string, string>;
  stdin?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface FileUpload {
  path: string;
  content: string | Buffer;
}

export interface FileDownload {
  path: string;
  content: Buffer;
}
```

---

## Factory

The factory function creates the appropriate provider based on configuration:

```typescript
// services/sandbox/src/factory.ts

export type SandboxProvider = "e2b" | "fly" | "docker";

export function createSandboxService(
  provider: SandboxProvider,
  config: Record<string, string>
): SandboxService {
  switch (provider) {
    case "e2b":    return new E2BSandboxService(config);
    case "fly":    return new FlySandboxService(config);
    case "docker": return new DockerSandboxService(config);
    default:       throw new Error(`Unknown sandbox provider: ${provider}`);
  }
}
```

Provider selection strategy:

| Context | Provider | Rationale |
|---|---|---|
| Local dev / `gents chat` | `docker` | No external dependencies, fast iteration |
| Cloud production | `e2b` | Managed, fast cold-start, built-in file API |
| High-scale / long-running | `fly` | Persistent machines, volume mounts, custom images |

---

## E2B Implementation (Primary)

```typescript
// services/sandbox/src/providers/e2b.ts

import { Sandbox as E2BSandbox } from "@e2b/code-interpreter";

export class E2BSandboxService implements SandboxService {
  constructor(private config: { apiKey: string }) {}

  async create(config: SandboxConfig): Promise<Sandbox> {
    const sbx = await E2BSandbox.create({
      apiKey: this.config.apiKey,
      timeout: config.timeout * 60 * 1000,
      metadata: config.env,
    });
    return new E2BSandboxAdapter(sbx);
  }

  async destroy(sandboxId: string): Promise<void> {
    await E2BSandbox.kill(sandboxId, { apiKey: this.config.apiKey });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    try {
      const sbx = await E2BSandbox.connect(sandboxId, {
        apiKey: this.config.apiKey,
      });
      return new E2BSandboxAdapter(sbx);
    } catch {
      return null;
    }
  }

  async list(): Promise<{ id: string; status: string; createdAt: Date }[]> {
    const sandboxes = await E2BSandbox.list({ apiKey: this.config.apiKey });
    return sandboxes.map(s => ({
      id: s.sandboxId,
      status: "ready",
      createdAt: new Date(s.startedAt),
    }));
  }
}
```

### E2B Adapter

The adapter wraps the E2B SDK's `Sandbox` instance to conform to our `Sandbox` interface:

```typescript
class E2BSandboxAdapter implements Sandbox {
  constructor(private sbx: E2BSandbox) {}

  get id() { return this.sbx.sandboxId; }
  get status() { return "ready" as const; }
  get url() { return `https://${this.sbx.getHost(80)}`; }

  getHost(port: number): string { return this.sbx.getHost(port); }

  async keepAlive(durationMs: number): Promise<void> {
    await this.sbx.setTimeout(durationMs);
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const start = Date.now();
    const result = await this.sbx.commands.run(command, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ? opts.timeout * 1000 : undefined,
      envs: opts?.env,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
    };
  }

  async readFile(path: string): Promise<string> {
    return await this.sbx.files.read(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sbx.files.write(path, content);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await this.sbx.files.list(path);
    return entries.map(e => ({
      name: e.name,
      path: e.path,
      type: e.type,
      size: e.size,
    }));
  }

  async uploadFiles(files: FileUpload[]): Promise<void> {
    for (const file of files) {
      await this.sbx.files.write(file.path, file.content.toString());
    }
  }

  async downloadFiles(paths: string[]): Promise<FileDownload[]> {
    const results: FileDownload[] = [];
    for (const path of paths) {
      const content = await this.sbx.files.read(path);
      results.push({ path, content: Buffer.from(content) });
    }
    return results;
  }
}
```

---

## Docker Implementation (Local Dev)

For local development and testing. Uses the Docker socket to create containers that mirror the sandbox interface.

```typescript
// services/sandbox/src/providers/docker.ts

import { execSync, spawn } from "child_process";

export class DockerSandboxService implements SandboxService {
  constructor(private config: { image?: string }) {}

  async create(config: SandboxConfig): Promise<Sandbox> {
    const image = config.image || this.config.image || "ubuntu:22.04";
    const id = `gents-sandbox-${Date.now()}`;

    execSync(
      `docker run -d --name ${id} ` +
      `--memory=${config.resources?.memory || "512m"} ` +
      `--cpus=${config.resources?.cpu || "1"} ` +
      `${image} sleep infinity`
    );

    return new DockerSandboxAdapter(id);
  }

  async destroy(sandboxId: string): Promise<void> {
    execSync(`docker rm -f ${sandboxId}`);
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    try {
      const output = execSync(
        `docker inspect ${sandboxId} --format '{{.State.Status}}'`
      ).toString().trim();
      if (output === "running") return new DockerSandboxAdapter(sandboxId);
      return null;
    } catch {
      return null;
    }
  }

  async list() {
    const output = execSync(
      `docker ps --filter name=gents-sandbox --format '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}'`
    ).toString().trim();
    if (!output) return [];
    return output.split("\n").map(line => {
      const [, name, createdAt] = line.split("\t");
      return { id: name, status: "ready", createdAt: new Date(createdAt) };
    });
  }
}
```

### Docker Adapter Considerations

The Docker adapter needs to implement file operations via `docker cp` and `docker exec`:

- `exec()` → `docker exec <id> sh -c "<command>"`
- `readFile()` → `docker exec <id> cat <path>`
- `writeFile()` → pipe content via stdin to `docker exec <id> tee <path>`
- `listDir()` → `docker exec <id> find <path> -maxdepth 1`
- `uploadFiles()` → `docker cp <local> <id>:<remote>`
- `downloadFiles()` → `docker cp <id>:<remote> <local>`
- `getHost()` → requires port mapping at creation time (`-p` flags)
- `keepAlive()` → no-op (Docker containers don't auto-expire)

---

## Fly Implementation (Future)

Placeholder for production-scale workloads that need persistent machines, custom images, or volume mounts.

**Target API:** Fly Machines API v1 (`https://api.machines.dev/v1/apps/:app/machines`)

Key differences from E2B:
- Machines are persistent and can be stopped/started (vs. E2B's ephemeral model)
- Volume mounts for caching (`node_modules`, pip cache) across runs
- Custom Docker images built from user repos
- Regional placement for latency optimization

---

## Implementation Plan

### Phase 1: Types & Docker Provider (Day 1)

1. Scaffold `services/sandbox` package
2. Define all interfaces in `types.ts`
3. Implement the factory in `factory.ts`
4. Implement `DockerSandboxService` and `DockerSandboxAdapter`
5. Write integration tests using Docker (requires Docker daemon)

### Phase 2: E2B Provider (Day 2)

1. Determine the correct E2B SDK package and version (`@e2b/code-interpreter` vs `@e2b/sdk`)
2. Implement `E2BSandboxService` and `E2BSandboxAdapter`
3. Handle E2B-specific error codes and map to our error types
4. Test against a real E2B sandbox (requires API key)
5. Validate streaming exec support (`onStdout`/`onStderr` callbacks)

### Phase 3: Lifecycle Management (Day 3)

1. Implement sandbox reaper logic — a background task that destroys sandboxes past their timeout
2. Add sandbox tracking to the task record (`sandboxId` field on `Task`)
3. Wire sandbox destruction into task completion/failure handlers
4. Handle orphaned sandboxes from crashed workflows (reaper queries for sandboxes with no active task)

### Phase 4: Fly Provider (Future)

1. Define Fly Machines API client
2. Implement `FlySandboxService` with machine start/stop lifecycle
3. Add volume mount support for persistent caches
4. Regional routing based on config

---

## Error Handling

| Error | Provider | Recovery |
|---|---|---|
| Sandbox creation timeout | All | Retry once. If still failing, fail the task with a "sandbox unavailable" error. |
| E2B API key invalid/expired | E2B | Fail immediately. Alert ops. |
| E2B rate limit (429) | E2B | Back off using `Retry-After`, then retry. |
| Docker daemon not running | Docker | Fail with a clear error message pointing the user to start Docker. |
| Sandbox OOM killed | All | Detect via non-zero exit code from exec. Log and report to user. Consider increasing memory limits. |
| Sandbox timeout (auto-killed) | E2B | Sandbox is gone. Fail the task. Log the timeout for cost analysis. |
| Exec timeout | All | Kill the command, return a timeout error. Don't destroy the sandbox — other commands may still work. |
| File not found | All | Return a clear error. Don't retry. |

---

## Resource Limits

Default resource limits for sandboxes:

| Resource | Default | Max | Notes |
|---|---|---|---|
| CPU | 1 core | 4 cores | E2B and Fly support fractional cores |
| Memory | 512 MB | 4 GB | OOM kills should be logged and reported |
| Timeout | 30 min | 120 min | Sandbox auto-destroyed after timeout |
| Disk | Provider default | — | E2B provides ~5 GB ephemeral, Docker uses container overlay |
| Network | Outbound only | — | Inbound only via exposed ports with `getHost()` |

---

## Observability

- **Metrics:** sandbox creation latency, sandbox lifetime distribution, exec command latency, sandbox count (active, creating, stopped), provider-specific error rates
- **Logging:** log sandbox creation/destruction with `sandboxId` and `taskId`, log all exec commands with duration and exit code, log file operations above a size threshold
- **Alerting:** alert on sandbox creation failure rate > 10%, alert on sandbox count exceeding capacity, alert on sandboxes running past 2x their configured timeout

---

## Open Questions

### Must-resolve before implementation

1. **E2B SDK version**: E2B ships `@e2b/code-interpreter` and `@e2b/sdk`. Which package, which version? We need the one that supports `commands.run`, `files.read/write/list`. The `code-interpreter` package may include Python-specific features we don't need.

2. **Sandbox lifecycle ownership**: Who is responsible for destroying sandboxes when a task finishes? The workflow runner? The TaskDispatcher on completion callback? A reaper cron? What about sandboxes orphaned by crashed workflows? We need a clear ownership model.

3. **Streaming exec output**: The interface has optional `onStdout`/`onStderr` callbacks. Does E2B support streaming, or only batch results? If E2B only supports batch, do we fake streaming by polling, or do we drop the streaming callbacks from the interface?

### Should-resolve before production

4. **Networking & secrets**: How do sandboxes access private repos? Do we inject a GitHub token into the sandbox environment? How is that token scoped (read-only? repo-specific?) and rotated? The `env` field on `SandboxConfig` is the mechanism, but the policy needs definition.

5. **Persistent storage**: Do sandboxes need volume mounts for caching (`node_modules`, pip cache) across runs for the same repo? This would dramatically reduce setup time for repeat runs but requires Fly or a similar provider with volume support.

6. **Binary file handling**: `readFile` returns a string. How do we handle binary files (images, compiled artifacts) that agents might produce? Options: add `readBinaryFile` returning `Buffer`, or change `readFile` to return `Buffer` always and add encoding options.

7. **Resource limits per plan**: What are sensible default CPU/memory limits? Should these vary by pricing tier? How do we handle OOM kills or runaway processes inside the sandbox gracefully?

### Can-defer to v2

8. **Custom sandbox images**: Can users bring their own Docker images with pre-installed toolchains? This is powerful but adds complexity around image security scanning and build pipelines.

9. **Sandbox snapshotting**: Can we snapshot a sandbox mid-run and restore it later? Useful for debugging failed runs or for checkpointing long tasks.

10. **Multi-sandbox tasks**: Some workflows might benefit from multiple sandboxes (e.g. one for frontend, one for backend). The current interface is one sandbox per task. Should the runner be able to request multiple?
