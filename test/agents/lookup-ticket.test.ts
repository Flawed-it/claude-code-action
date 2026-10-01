import { describe, test, expect } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { lookupTicket, parseTicketId } from "../../agents/lookup-ticket";

function createMockOctokit(
  get: (params: {
    owner: string;
    repo: string;
    issue_number: number;
  }) => Promise<unknown>,
): Octokit {
  return { rest: { issues: { get } } } as unknown as Octokit;
}

const issue = {
  title: "Fix login",
  state: "closed",
  state_reason: "completed",
  body: "Users cannot log in.",
  labels: ["bug", { name: "auth" }],
  html_url: "https://github.com/acme/app/issues/42",
};

describe("parseTicketId", () => {
  test("parses owner/repo#number", () => {
    expect(parseTicketId("acme/app#42")).toEqual({
      owner: "acme",
      repo: "app",
      number: 42,
    });
  });

  test("parses issue and pull request URLs", () => {
    expect(parseTicketId("https://github.com/acme/app/issues/42")).toEqual({
      owner: "acme",
      repo: "app",
      number: 42,
    });
    expect(parseTicketId("https://github.com/acme/app/pull/7#top")).toEqual({
      owner: "acme",
      repo: "app",
      number: 7,
    });
  });

  test("resolves bare numbers against the default repo", () => {
    expect(parseTicketId("#42", "acme/app")).toEqual({
      owner: "acme",
      repo: "app",
      number: 42,
    });
    expect(parseTicketId(" 42 ", "acme/app").number).toBe(42);
  });

  test("rejects bare numbers without a valid default repo", () => {
    expect(() => parseTicketId("42")).toThrow("no default repository");
    expect(() => parseTicketId("42", "acme")).toThrow("no default repository");
  });

  test("rejects unrecognized IDs", () => {
    expect(() => parseTicketId("ENG-4417", "acme/app")).toThrow(
      "Unrecognized ticket ID",
    );
  });
});

describe("lookupTicket", () => {
  test("returns the formatted ticket", async () => {
    let requested: unknown;
    const octokit = createMockOctokit(async (params) => {
      requested = params;
      return { data: issue };
    });

    const result = await lookupTicket(
      octokit,
      { ticket_id: "#42" },
      "acme/app",
    );

    expect(requested).toEqual({ owner: "acme", repo: "app", issue_number: 42 });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      [
        "Issue acme/app#42: Fix login",
        "Status: closed (completed)",
        "Labels: bug, auth",
        "URL: https://github.com/acme/app/issues/42",
        "",
        "Users cannot log in.",
      ].join("\n"),
    );
  });

  test("marks pull requests and empty bodies", async () => {
    const octokit = createMockOctokit(async () => ({
      data: {
        ...issue,
        state: "open",
        state_reason: null,
        body: null,
        labels: [],
        pull_request: {},
      },
    }));

    const result = await lookupTicket(octokit, { ticket_id: "acme/app#42" });

    expect(result.text).toStartWith("Pull request acme/app#42: Fix login");
    expect(result.text).toContain("Status: open\n");
    expect(result.text).toContain("Labels: none");
    expect(result.text).toEndWith("(no description)");
  });

  test("returns an error result for a missing ticket without retrying", async () => {
    let calls = 0;
    const octokit = createMockOctokit(async () => {
      calls++;
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const result = await lookupTicket(octokit, { ticket_id: "acme/app#999" });

    expect(calls).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("was not found");
  });

  test("returns an error result for invalid input", async () => {
    const octokit = createMockOctokit(async () => ({ data: issue }));

    expect((await lookupTicket(octokit, {})).isError).toBe(true);
    expect(
      (await lookupTicket(octokit, { ticket_id: "ENG-4417" }, "acme/app")).text,
    ).toContain("Unrecognized ticket ID");
  });
});
