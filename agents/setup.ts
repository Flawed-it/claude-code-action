#!/usr/bin/env bun
/**
 * Creates (or updates) the Research Agent and a Managed Agents environment,
 * then prints the IDs that agents/run-researcher.ts needs. Use it where the
 * `ant` CLI is not installed.
 *
 * Usage:
 *   bun agents/setup.ts [--model <model-id>]
 *
 *   --model   Override the model id in researcher.agent.yaml, e.g.
 *             claude-fable-5 for orgs not enrolled in Project Glasswing.
 *
 * Environment:
 *   ANTHROPIC_API_KEY         Claude API key (or an `ant auth login` profile)
 *   ANTHROPIC_AGENT_ID        Optional. When set, that agent is updated from
 *                             the YAML instead of creating a new one.
 *   ANTHROPIC_ENVIRONMENT_ID  Optional. When set, that environment is reused.
 *
 * Prints `export` lines on stdout, so `eval "$(bun agents/setup.ts)"` sets
 * both IDs in the current shell. Progress goes to stderr.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import { readFileSync } from "fs";
import { load as parseYaml } from "js-yaml";

const CONFIG_PATH = new URL("./researcher.agent.yaml", import.meta.url);

export function loadAgentConfig(
  yamlText: string,
  modelOverride?: string,
): AgentCreateParams {
  const config = parseYaml(yamlText) as AgentCreateParams | null;
  if (!config || typeof config.name !== "string" || !config.model) {
    throw new Error("researcher.agent.yaml must define name and model");
  }
  if (modelOverride) {
    // Keep effort and other model settings; only swap the id.
    config.model =
      typeof config.model === "string"
        ? modelOverride
        : { ...config.model, id: modelOverride };
  }
  return config;
}

function parseModelFlag(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--model needs a model id, e.g. --model claude-fable-5");
  }
  return value;
}

async function main() {
  const config = loadAgentConfig(
    readFileSync(CONFIG_PATH, "utf8"),
    parseModelFlag(process.argv.slice(2)),
  );
  const client = new Anthropic();

  // Agent first: a rejected model then leaves nothing half-created.
  let agentId = process.env.ANTHROPIC_AGENT_ID;
  try {
    if (agentId) {
      const agent = await client.beta.agents.update(agentId, config);
      console.error(`Updated agent ${agent.id} (version ${agent.version})`);
    } else {
      const agent = await client.beta.agents.create(config);
      agentId = agent.id;
      console.error(`Created agent ${agent.id} (version ${agent.version})`);
    }
  } catch (error) {
    if (error instanceof Anthropic.APIError && error.status === 400) {
      console.error(
        "If the model was rejected, your org may not be enrolled in Project Glasswing or may use zero data retention. Retry with --model claude-fable-5.",
      );
    }
    throw error;
  }

  let environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID;
  if (environmentId) {
    console.error(`Reusing environment ${environmentId}`);
  } else {
    const environment = await client.beta.environments.create({
      name: "research-agent",
      config: {
        type: "cloud",
        networking: { type: "limited", allow_package_managers: true },
      },
    });
    environmentId = environment.id;
    console.error(`Created environment ${environmentId}`);
  }

  console.log(`export ANTHROPIC_ENVIRONMENT_ID=${environmentId}`);
  console.log(`export ANTHROPIC_AGENT_ID=${agentId}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
