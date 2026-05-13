#!/usr/bin/env bun
import { Command } from "commander";

import { initTelemetry } from "@gents/agent-otel";
import { chatCommand } from "./commands/chat";
import { configCommand } from "./commands/config";
import { doctorCommand } from "./commands/doctor";
import { indexCommand } from "./commands/index";
import { inspectCommand } from "./commands/inspect";
import { mcpCommand } from "./commands/mcp";
import { searchCommand } from "./commands/search";

initTelemetry({ enabled: process.env.GENTS_OTEL === "1", serviceName: "gents-cli" });

const program = new Command()
  .name("gents")
  .description("Local-first AI coding agent")
  .version("0.1.0")
  .option("-v, --verbose", "Enable debug output")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().verbose) {
      process.env.GENTS_VERBOSE = "1";
    }
  });

program.addCommand(chatCommand);
program.addCommand(searchCommand);
program.addCommand(indexCommand);
program.addCommand(inspectCommand);
program.addCommand(mcpCommand);
program.addCommand(configCommand);
program.addCommand(doctorCommand);

program.parse();
