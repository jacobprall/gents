# Services Layer (`services/`)

The services layer contains framework-agnostic business logic and provider abstractions that power the gents cloud platform. Services are consumed by the Next.js app, the CLI, tests, and the Render Workflow runner.

---

## Architecture Overview

```
services/
  workflow/               ← WorkflowService (Render Workflows)
  sandbox/                ← SandboxService (E2B, Fly, Docker)
  auth/                   ← AuthService (NextAuth + API keys)
  github/                 ← GitHub webhook parsing + API client
  tasks/                  ← Task lifecycle (CRUD, dispatch, events)
```

### Design Principles

- **Interface-first**: every service defines a TypeScript interface before any implementation. Consumers depend on the interface, never the concrete class.
- **Provider-pluggable**: infrastructure services (workflow, sandbox) use a factory/adapter pattern so providers can be swapped without touching callers.
- **Framework-agnostic**: no Next.js, no Express, no HTTP assumptions. Services accept plain objects and return plain objects. HTTP concerns live in `apps/web`.
- **Testable in isolation**: every service can be instantiated with a mock or in-memory backend. No ambient singletons; dependencies are injected via constructors.

---

## Service Specs

Each service has its own detailed spec with interfaces, implementation code, phased implementation plans, and open questions:

| Service | Package | Spec | Purpose |
|---|---|---|---|
| Workflow | `@gents/workflow` | [workflow.md](./workflow.md) | Dispatch and track Render Workflows |
| Sandbox | `@gents/sandbox` | [sandbox.md](./sandbox.md) | Provision isolated execution environments (E2B, Docker, Fly) |
| Auth | `@gents/auth` | [auth.md](./auth.md) | Authentication, API keys, user management |
| GitHub | `@gents/github` | [github.md](./github.md) | Webhook parsing, event routing, GitHub API client |
| Tasks | `@gents/tasks` | [tasks.md](./tasks.md) | Task lifecycle, dispatch orchestration, steering messages |
| Database | — | [database.md](./database.md) | Schema, migrations, connection pooling |

Each package ships its own `package.json`, `tsconfig.json`, and `src/index.ts` barrel export. All compile to ESM with TypeScript declaration files.

---

## Implementation Order

### Phase A: Foundation (2–3 days)

1. Scaffold all five service packages — `types.ts` + `index.ts` barrel for each
2. Set up `tsconfig.json` with project references so services can import each other's types
3. Database migrations with a simple runner script — see [database.md](./database.md)
4. Auth service — API key generation + verification, NextAuth adapter wiring — see [auth.md](./auth.md)

### Phase B: Core Services (2–3 days)

5. TaskRepository — full Postgres CRUD for tasks, logs, messages, routing rules — see [tasks.md](./tasks.md)
6. WorkflowService — Render implementation + mock for tests — see [workflow.md](./workflow.md)
7. SandboxService — E2B implementation + Docker for local dev — see [sandbox.md](./sandbox.md)
8. GitHub service — webhook parsing, signature verification, routing — see [github.md](./github.md)

### Phase C: Orchestration (1–2 days)

9. TaskDispatcher — wire up task creation → RunnerSpec → workflow dispatch
10. Event ingestion — callback handler that updates task state from runner events
11. Steering messages — send/receive loop between dashboard and running agent

### Phase D: Integration Testing (1–2 days)

12. End-to-end test: create task → mock workflow → callback events → verify state transitions
13. GitHub webhook → routing rule match → task dispatch flow
14. Auth flow: API key creation → authenticated request → task creation

---

## Cross-Cutting Concerns

### Error Handling

All services throw typed errors (e.g. `WorkflowDispatchError`, `AuthenticationError`) with HTTP-friendly status codes. The web layer catches these and maps to JSON responses.

### Logging

Services accept an optional logger interface rather than importing a specific logger. This keeps them framework-agnostic and testable.

### Configuration

Each service constructor takes an explicit config object — no ambient `process.env` reads inside services. The web layer reads env vars and passes config at initialization time.

### Testing Strategy

- **Unit tests**: each service method tested against mocks/in-memory backends
- **Integration tests**: TaskRepository + real Postgres (via testcontainers or a test DB)
- **Contract tests**: verify service interfaces are correctly implemented by all providers
