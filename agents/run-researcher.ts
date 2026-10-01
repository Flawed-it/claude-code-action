#!/usr/bin/env bun
/**
 * Runs one Research Agent session and answers its `lookup_ticket` calls from
 * GitHub Issues, so the GitHub token stays on this machine and never enters
 * the agent's sandbox.
 *
 * Usage:
 *   bun agents/run-researcher.ts "Summarize the state of owner/repo#42"
 *
 * Environment:
 *   ANTHROPIC_API_KEY           Claude API key (or an `ant auth login` profile)
 *   ANTHROPIC_AGENT_ID          ID printed by agents/setup.ts (or `ant beta:agents create`)
 *   ANTHROPIC_ENVIRONMENT_ID    Environment printed by agents/setup.ts
 *   GITHUB_TOKEN                Token that can read the ticket repositories
 *   LOOKUP_TICKET_DEFAULT_REPO  owner/repo used for bare IDs like #42
 *                               (falls back to GITHUB_REPOSITORY)
 */
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { lookupTicket, type ToolResult } from "./lookup-ticket";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function runCustomTool(
  octokit: Octokit,
  name: string,
  input: Record<string, unknown>,
  defaultRepo: string | undefined,
): Promise<ToolResult> {
  if (name === "lookup_ticket") {
    return lookupTicket(octokit, input, defaultRepo);
  }
  return { text: `Unknown custom tool: ${name}`, isError: true };
}

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    throw new Error('Usage: bun agents/run-researcher.ts "<question>"');
  }

  const client = new Anthropic();
  const octokit = new Octokit({ auth: requireEnv("GITHUB_TOKEN") });
  const defaultRepo =
    process.env.LOOKUP_TICKET_DEFAULT_REPO || process.env.GITHUB_REPOSITORY;

  const session = await client.beta.sessions.create({
    agent: requireEnv("ANTHROPIC_AGENT_ID"),
    environment_id: requireEnv("ANTHROPIC_ENVIRONMENT_ID"),
    title: prompt.slice(0, 80),
  });
  console.error(`Session ${session.id}`);

  // Open the stream before sending the first message so no events are missed.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [
      { type: "user.message", content: [{ type: "text", text: prompt }] },
    ],
  });

  const pendingToolUses = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const block of event.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        }
      }
    } else if (event.type === "agent.custom_tool_use") {
      pendingToolUses.set(event.id, { name: event.name, input: event.input });
    } else if (event.type === "session.status_terminated") {
      break;
    } else if (event.type === "session.status_idle") {
      if (event.stop_reason.type !== "requires_action") {
        if (event.stop_reason.type !== "end_turn") {
          console.error(`\nSession stopped: ${event.stop_reason.type}`);
        }
        break;
      }

      // Answer every custom tool call the agent is blocked on. Anything else
      // it waits for (such as a tool confirmation) is not ours to answer.
      const blockedOn = event.stop_reason.event_ids.filter((id) =>
        pendingToolUses.has(id),
      );
      if (blockedOn.length === 0) {
        continue;
      }
      const results = await Promise.all(
        blockedOn.map(async (id) => {
          const call = pendingToolUses.get(id)!;
          pendingToolUses.delete(id);
          console.error(`\n[${call.name}] ${JSON.stringify(call.input)}`);
          const result = await runCustomTool(
            octokit,
            call.name,
            call.input,
            defaultRepo,
          );
          return {
            type: "user.custom_tool_result" as const,
            custom_tool_use_id: id,
            content: [{ type: "text" as const, text: result.text }],
            is_error: result.isError,
          };
        }),
      );
      await client.beta.sessions.events.send(session.id, { events: results });
    }
  }
  process.stdout.write("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
