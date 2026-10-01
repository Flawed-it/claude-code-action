import type { Octokit } from "@octokit/rest";
import { retryWithBackoff } from "../src/utils/retry";

export type TicketRef = { owner: string; repo: string; number: number };

export type Ticket = {
  ref: TicketRef;
  title: string;
  status: string;
  body: string;
  labels: string[];
  url: string;
  isPullRequest: boolean;
};

const URL_PATTERN =
  /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/;
const QUALIFIED_PATTERN = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const BARE_PATTERN = /^#?(\d+)$/;

/**
 * Parses a ticket ID into a GitHub issue reference. Accepts
 * `owner/repo#123`, a github.com issue or pull request URL, or `#123` / `123`
 * (resolved against `defaultRepo`, given as `owner/repo`).
 */
export function parseTicketId(
  ticketId: string,
  defaultRepo?: string,
): TicketRef {
  const id = ticketId.trim();

  const url = URL_PATTERN.exec(id) ?? QUALIFIED_PATTERN.exec(id);
  if (url) {
    return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };
  }

  const bare = BARE_PATTERN.exec(id);
  if (bare) {
    const [owner, repo, ...rest] = (defaultRepo ?? "").split("/");
    if (!owner || !repo || rest.length > 0) {
      throw new Error(
        `Ticket "${ticketId}" has no repository and no default repository is configured. Use owner/repo#number.`,
      );
    }
    return { owner, repo, number: Number(bare[1]) };
  }

  throw new Error(
    `Unrecognized ticket ID "${ticketId}". Use owner/repo#number, #number, or a GitHub issue URL.`,
  );
}

function isRetryable(error: Error): boolean {
  const status = (error as Error & { status?: number }).status;
  return status === undefined || status === 429 || status >= 500;
}

export async function fetchTicket(
  octokit: Octokit,
  ref: TicketRef,
): Promise<Ticket> {
  const { data } = await retryWithBackoff(
    () =>
      octokit.rest.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
      }),
    { initialDelayMs: 1000, shouldRetry: isRetryable },
  );

  return {
    ref,
    title: data.title,
    status: data.state_reason
      ? `${data.state} (${data.state_reason})`
      : data.state,
    body: data.body ?? "",
    labels: data.labels.map((label) =>
      typeof label === "string" ? label : (label.name ?? ""),
    ),
    url: data.html_url,
    isPullRequest: data.pull_request !== undefined,
  };
}

export function formatTicket(ticket: Ticket): string {
  const { owner, repo, number } = ticket.ref;
  const kind = ticket.isPullRequest ? "Pull request" : "Issue";
  return [
    `${kind} ${owner}/${repo}#${number}: ${ticket.title}`,
    `Status: ${ticket.status}`,
    `Labels: ${ticket.labels.length > 0 ? ticket.labels.join(", ") : "none"}`,
    `URL: ${ticket.url}`,
    "",
    ticket.body || "(no description)",
  ].join("\n");
}

export type ToolResult = { text: string; isError: boolean };

/**
 * Handles one `lookup_ticket` call. Failures come back as error results rather
 * than exceptions, so the agent sees what went wrong instead of the runner
 * crashing.
 */
export async function lookupTicket(
  octokit: Octokit,
  input: Record<string, unknown>,
  defaultRepo?: string,
): Promise<ToolResult> {
  const ticketId = input.ticket_id;
  if (typeof ticketId !== "string" || ticketId.trim() === "") {
    return { text: "ticket_id must be a non-empty string.", isError: true };
  }

  try {
    const ticket = await fetchTicket(
      octokit,
      parseTicketId(ticketId, defaultRepo),
    );
    return { text: formatTicket(ticket), isError: false };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message =
      status === 404
        ? `Ticket "${ticketId}" was not found, or the token cannot read that repository.`
        : `Failed to look up ticket "${ticketId}": ${error instanceof Error ? error.message : String(error)}`;
    return { text: message, isError: true };
  }
}
