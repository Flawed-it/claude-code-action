import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { loadAgentConfig } from "../../agents/setup";

const yamlText = readFileSync(
  new URL("../../agents/researcher.agent.yaml", import.meta.url),
  "utf8",
);

describe("loadAgentConfig", () => {
  test("loads the researcher agent config", () => {
    const config = loadAgentConfig(yamlText);

    expect(config.name).toBe("Research Agent");
    expect(config.model).toEqual({ id: "claude-mythos-5", effort: "high" });
    expect(config.tools?.map((tool) => tool.type)).toEqual([
      "agent_toolset_20260401",
      "custom",
    ]);
    expect(config.tools?.[1]).toMatchObject({
      name: "lookup_ticket",
      input_schema: { required: ["ticket_id"] },
    });
  });

  test("overrides the model id and keeps effort", () => {
    expect(loadAgentConfig(yamlText, "claude-fable-5").model).toEqual({
      id: "claude-fable-5",
      effort: "high",
    });
  });

  test("overrides a string model", () => {
    expect(
      loadAgentConfig("name: A\nmodel: claude-mythos-5\n", "claude-fable-5")
        .model,
    ).toBe("claude-fable-5");
  });

  test("rejects a config without name or model", () => {
    expect(() => loadAgentConfig("name: A\n")).toThrow("name and model");
    expect(() => loadAgentConfig("")).toThrow();
    expect(() => loadAgentConfig("null\n")).toThrow("name and model");
  });
});
