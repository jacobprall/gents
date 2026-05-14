# Notifications

**Priority: P2** — important for team awareness, but teams can watch the dashboard initially.

Notifies team members when significant events happen: task completion/failure, budget alerts, steering requests. Starts with Slack webhooks and GitHub PR comments; email and richer integrations can follow.

---

## Design Decisions

### Slack Incoming Webhooks for V1

Slack is where engineering teams already live. Incoming webhooks are the simplest integration — no Slack App review, no OAuth flow, no bot user. The team admin pastes a webhook URL and picks which events trigger messages.

A Slack App (with slash commands like `/gents status`) is a natural follow-up but requires Slack marketplace review and adds OAuth complexity.

### GitHub Comments as a Notification Channel

When a task is triggered by a webhook on a PR or issue, the agent should be able to post its results back as a comment on that PR/issue. This closes the loop — the developer sees the agent's work in the same place they're already looking.

This uses the GitHub App's installation token, so no additional authentication is needed.

### Per-Team Configuration, Per-User Preferences

Notification channels are configured at the team level (team admin sets up the Slack webhook). But individual members can override which events they care about (future: per-user preference toggles).

---

## Data Model

### Notification Channel Config

```typescript
// services/notifications/src/types.ts

export interface NotificationChannelConfig {
  id: string;
  teamId: string;
  channel: NotificationChannel;
  name: string;                      // display name, e.g. "Engineering Slack"
  events: NotificationEvent[];
  config: ChannelSpecificConfig;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationChannel = "slack" | "github_comment" | "email";

export type NotificationEvent =
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.needs_steering"            // agent hit a pause (cost guard, confirmation)
  | "budget.alert"                   // team hit budget threshold
  | "budget.exhausted"               // team budget fully used
  | "member.joined"                  // new member joined the team
  | "webhook.error";                 // webhook processing failed

export type ChannelSpecificConfig =
  | SlackChannelConfig
  | GitHubCommentConfig
  | EmailChannelConfig;

export interface SlackChannelConfig {
  type: "slack";
  webhookUrl: string;
  channel?: string;                  // override, if webhook targets a different channel
  username?: string;                 // bot display name (default: "gents")
  iconEmoji?: string;                // bot icon (default: ":robot_face:")
  includeConversationExcerpt?: boolean;
}

export interface GitHubCommentConfig {
  type: "github_comment";
  postOnPR: boolean;                 // comment on the PR when task completes
  postOnIssue: boolean;              // comment on the issue
  includeTaskLink: boolean;          // link back to dashboard
  includeCostSummary: boolean;       // show cost and turn count
}

export interface EmailChannelConfig {
  type: "email";
  recipients: string[];              // email addresses
  digestMode: "immediate" | "daily"; // send per-event or daily digest
}
```

### Notification Payload

The data passed to the notification service when an event fires:

```typescript
export interface NotificationPayload {
  event: NotificationEvent;
  teamId: string;
  task?: {
    id: string;
    status: string;
    instructions: string;
    repo: string;
    ref: string;
    costUsd: number;
    turnCount: number;
    createdBy: string;
    origin: string;
    dashboardUrl: string;
    duration?: string;
    result?: Record<string, unknown>;
    error?: string;
  };
  budget?: {
    usedPct: number;
    limitUsd: number;
    spentUsd: number;
  };
  member?: {
    userId: string;
    name: string;
    login: string;
  };
  pr?: {
    owner: string;
    repo: string;
    number: number;
  };
  issue?: {
    owner: string;
    repo: string;
    number: number;
  };
}
```

---

## NotificationService Interface

```typescript
// services/notifications/src/types.ts

export interface NotificationService {
  // Channel management
  createChannel(config: Omit<NotificationChannelConfig, "id" | "createdAt" | "updatedAt">): Promise<NotificationChannelConfig>;
  updateChannel(id: string, updates: Partial<NotificationChannelConfig>): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  listChannels(teamId: string): Promise<NotificationChannelConfig[]>;

  // Test a channel (sends a test message)
  testChannel(id: string): Promise<{ success: boolean; error?: string }>;

  // Fire a notification (dispatches to all matching channels)
  notify(teamId: string, payload: NotificationPayload): Promise<void>;
}
```

---

## Slack Integration

### Message Formatting

```typescript
// services/notifications/src/channels/slack.ts

function formatSlackMessage(payload: NotificationPayload): SlackMessage {
  switch (payload.event) {
    case "task.completed":
      return {
        text: `Task completed: ${payload.task!.instructions.slice(0, 80)}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*Task completed* :white_check_mark:`,
                `> ${payload.task!.instructions.slice(0, 200)}`,
                ``,
                `*Repo:* \`${payload.task!.repo}\` · *Branch:* \`${payload.task!.ref}\``,
                `*Cost:* $${payload.task!.costUsd.toFixed(2)} · *Turns:* ${payload.task!.turnCount}` +
                  (payload.task!.duration ? ` · *Duration:* ${payload.task!.duration}` : ""),
                `*Origin:* ${payload.task!.origin} · *By:* ${payload.task!.createdBy}`,
              ].join("\n"),
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "View in Dashboard" },
                url: payload.task!.dashboardUrl,
              },
            ],
          },
        ],
      };

    case "task.failed":
      return {
        text: `Task failed: ${payload.task!.instructions.slice(0, 80)}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `*Task failed* :x:`,
                `> ${payload.task!.instructions.slice(0, 200)}`,
                ``,
                payload.task!.error ? `*Error:* ${payload.task!.error.slice(0, 300)}` : "",
                `*Repo:* \`${payload.task!.repo}\` · *Cost:* $${payload.task!.costUsd.toFixed(2)}`,
              ].filter(Boolean).join("\n"),
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "View Details" },
                url: payload.task!.dashboardUrl,
              },
            ],
          },
        ],
      };

    case "budget.alert":
      return {
        text: `Budget alert: ${payload.budget!.usedPct}% used`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `:warning: *Budget alert*`,
                `Team has used ${payload.budget!.usedPct}% of the monthly budget.`,
                `$${payload.budget!.spentUsd.toFixed(2)} / $${payload.budget!.limitUsd.toFixed(2)}`,
              ].join("\n"),
            },
          },
        ],
      };

    case "task.needs_steering":
      return {
        text: `Task paused — needs human input`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: [
                `:raised_hand: *Task paused — needs steering*`,
                `> ${payload.task!.instructions.slice(0, 200)}`,
                `The agent is waiting for human input.`,
              ].join("\n"),
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Steer Task" },
                url: payload.task!.dashboardUrl,
                style: "primary",
              },
            ],
          },
        ],
      };

    default:
      return { text: `gents: ${payload.event}` };
  }
}
```

### Sending

```typescript
// services/notifications/src/channels/slack.ts

export async function sendSlackNotification(
  config: SlackChannelConfig,
  payload: NotificationPayload,
): Promise<void> {
  const message = formatSlackMessage(payload);

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...message,
      username: config.username || "gents",
      icon_emoji: config.iconEmoji || ":robot_face:",
      channel: config.channel,
    }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}
```

---

## GitHub Comment Integration

When a task completes that was triggered by a PR or issue event, post the results as a comment.

### Comment Template

```markdown
## 🤖 gents agent completed

**Task:** Fix auth middleware to handle expired tokens
**Status:** ✅ Completed
**Cost:** $0.47 · **Turns:** 12 · **Duration:** 3m 22s

### Summary
The agent updated the auth middleware to check token expiration before processing requests. Changes include:
- Added `isTokenExpired()` check in `middleware.ts`
- Updated error handling to return 401 with `token_expired` code
- Added 3 test cases for expired token scenarios

[View full conversation →](https://gents.example.com/t/acme/tasks/abc123)
```

### Implementation

```typescript
// services/notifications/src/channels/github-comment.ts

export async function postGitHubComment(
  config: GitHubCommentConfig,
  payload: NotificationPayload,
  githubClient: GitHubClient,
): Promise<void> {
  if (!payload.task) return;

  const body = buildCommentBody(config, payload);

  if (config.postOnPR && payload.pr) {
    await githubClient.createComment(
      payload.pr.owner,
      payload.pr.repo,
      payload.pr.number,
      body,
    );
  }

  if (config.postOnIssue && payload.issue) {
    await githubClient.createComment(
      payload.issue.owner,
      payload.issue.repo,
      payload.issue.number,
      body,
    );
  }
}

function buildCommentBody(
  config: GitHubCommentConfig,
  payload: NotificationPayload,
): string {
  const task = payload.task!;
  const status = task.status === "completed" ? "✅ Completed" : "❌ Failed";
  const lines: string[] = [
    `## 🤖 gents agent ${task.status}`,
    ``,
    `**Task:** ${task.instructions.slice(0, 200)}`,
    `**Status:** ${status}`,
  ];

  if (config.includeCostSummary) {
    lines.push(
      `**Cost:** $${task.costUsd.toFixed(2)} · **Turns:** ${task.turnCount}` +
        (task.duration ? ` · **Duration:** ${task.duration}` : "")
    );
  }

  if (task.error) {
    lines.push(``, `**Error:** ${task.error.slice(0, 500)}`);
  }

  if (config.includeTaskLink) {
    lines.push(``, `[View full conversation →](${task.dashboardUrl})`);
  }

  return lines.join("\n");
}
```

---

## Integration Points

### Task Completion/Failure

In the callback handler, after updating task status:

```typescript
// In /api/tasks/:id/callback — completion handler
case "completion":
  await taskRepo.updateStatus(taskId, body.status, { ... });

  // Fire notification
  await notificationService.notify(task.teamId, {
    event: body.status === "completed" ? "task.completed" : "task.failed",
    teamId: task.teamId,
    task: {
      id: task.id,
      status: body.status,
      instructions: task.instructions || "",
      repo: task.repo || "",
      ref: task.ref || "",
      costUsd: task.costUsd,
      turnCount: task.turnCount,
      createdBy: task.createdBy,
      origin: task.origin,
      dashboardUrl: `${appUrl}/t/${teamSlug}/tasks/${task.id}`,
      error: body.error,
    },
    pr: extractPRContext(task),
    issue: extractIssueContext(task),
  });
  break;
```

### Budget Alerts

In the billing service, after recording cost:

```typescript
// services/billing/src/billing-service.ts

async recordCost(entry: ...): Promise<void> {
  await this.pool.query(/* insert into cost_ledger */);

  // Check if we just crossed the threshold
  const budget = await this.getTeamBudget(entry.teamId);
  if (budget.monthlyLimitUsd > 0) {
    const spend = await this.getTeamSpend(entry.teamId, currentPeriod());
    const pct = (spend.totalUsd / budget.monthlyLimitUsd) * 100;

    if (pct >= budget.alertThresholdPct) {
      const alreadyAlerted = await this.wasAlertSent(entry.teamId, currentPeriod());
      if (!alreadyAlerted) {
        await this.notificationService.notify(entry.teamId, {
          event: pct >= 100 ? "budget.exhausted" : "budget.alert",
          teamId: entry.teamId,
          budget: {
            usedPct: Math.round(pct),
            limitUsd: budget.monthlyLimitUsd,
            spentUsd: spend.totalUsd,
          },
        });
        await this.markAlertSent(entry.teamId, currentPeriod());
      }
    }
  }
}
```

---

## Database Schema

```sql
-- Part of migrations/008_notifications.sql

CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,               -- 'slack', 'github_comment', 'email'
  name TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '[]',  -- array of event strings
  config JSONB NOT NULL,               -- channel-specific config
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notification_channels_team ON notification_channels(team_id);

-- Track sent alerts to avoid duplicates
CREATE TABLE notification_dedup (
  team_id TEXT NOT NULL REFERENCES teams(id),
  event TEXT NOT NULL,
  dedup_key TEXT NOT NULL,             -- e.g. "2026-05" for monthly budget alerts
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, event, dedup_key)
);
```

---

## Outstanding Questions

### Delivery

- **Retry policy**: if a Slack webhook fails (5xx), do we retry? Yes, up to 3 times with exponential backoff (1s, 5s, 25s). Drop after that — we don't queue notifications indefinitely.
- **Rate limiting**: if 10 tasks complete in quick succession, do we send 10 Slack messages? Yes, but consider a short batching window (e.g. 5 seconds) to group them into a single message. Not for v1 — individual messages are fine.
- **Delivery log**: should we track which notifications were sent, to which channels, with success/failure? Yes — useful for debugging. Store in a `notification_log` table with TTL.

### Preferences

- **Per-user muting**: can a member mute `task.completed` notifications while keeping `task.failed`? Not for v1 — channel-level event filtering is sufficient. Per-user preferences require a user preferences table.
- **@mentions in Slack**: should the Slack message @mention the user who created the task? Optional. Requires mapping gents users to Slack user IDs, which is a Slack App feature (not available with webhooks). Defer.
- **DMs**: should critical events (budget exhausted, task failed) send DMs in addition to channel messages? Requires Slack App. Defer.

### Content

- **GitHub comment verbosity**: how much detail in the PR comment? Options: minimal (status + link), summary (status + cost + link), full (status + cost + conversation excerpt + link). Configurable via `GitHubCommentConfig`.
- **Conversation excerpt in Slack**: should Slack messages include the last few agent messages? Makes the message very long. Default to no; opt-in via `includeConversationExcerpt`.
- **Error details**: when a task fails, how much of the error do we include? Truncate at 500 chars. Link to dashboard for full details.

### Future Channels

- **Discord**: identical to Slack webhooks, just a different URL format. Easy to add.
- **Microsoft Teams**: incoming webhook connector, similar pattern to Slack.
- **PagerDuty**: for critical failures or budget exhaustion. Different integration pattern (events API).
- **Webhook (generic)**: POST to a user-configured URL with the payload JSON. Enables custom integrations.
