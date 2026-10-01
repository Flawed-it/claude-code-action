import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL(
  "../scripts/install-subprocess-isolation-dependencies.sh",
  import.meta.url,
);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeCommand(directory: string, name: string, body: string) {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function runInstaller(
  commands: Record<string, string>,
  env: Record<string, string> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "isolation-install-"));
  tempDirectories.push(directory);
  const log = join(directory, "commands.log");

  // The AppArmor step calls `sudo sysctl` on Ubuntu 24.04 runners; sysctl is
  // in /usr/sbin, which is not on the test PATH.
  const withDefaults = {
    sysctl: 'echo "sysctl $*" >> "$COMMAND_LOG"',
    ...commands,
  };
  for (const [name, body] of Object.entries(withDefaults)) {
    createFakeCommand(directory, name, body);
  }

  const result = spawnSync("bash", [script.pathname], {
    env: {
      ...process.env,
      PATH: `${directory}:/usr/bin:/bin`,
      COMMAND_LOG: log,
      ...env,
    },
    encoding: "utf8",
  });

  return {
    ...result,
    log: readFileSync(log, "utf8"),
  };
}

describe("subprocess isolation dependency installation", () => {
  test("runs the complete apt operation inside a hard three-minute timeout", () => {
    const result = runInstaller({
      "apt-get": 'echo "apt-get $*" >> "$COMMAND_LOG"',
      sudo: 'echo "sudo $*" >> "$COMMAND_LOG"; "$@"',
      timeout: 'echo "timeout $*" >> "$COMMAND_LOG"; shift 3; exec "$@"',
    });

    expect(result.status).toBe(0);
    expect(result.log).toContain(
      "timeout --signal=TERM --kill-after=10s 180s bash -c install_dependencies",
    );
    expect(result.log).toContain("apt-get update -qq");
    expect(result.log).toContain(
      "apt-get install -y --no-install-recommends bubblewrap socat",
    );
  });

  test("continues when the bounded installation times out", () => {
    const result = runInstaller({
      "apt-get": 'echo "apt-get $*" >> "$COMMAND_LOG"',
      sudo: 'echo "sudo $*" >> "$COMMAND_LOG"; "$@"',
      timeout: 'echo "timeout $*" >> "$COMMAND_LOG"; exit 124',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("failed or timed out; continuing");
    expect(result.log).toContain("180s");
  });

  test("disables the AppArmor user namespace restriction when the sysctl exists", () => {
    const sysctlDirectory = mkdtempSync(join(tmpdir(), "isolation-sysctl-"));
    tempDirectories.push(sysctlDirectory);
    const sysctlPath = join(
      sysctlDirectory,
      "apparmor_restrict_unprivileged_userns",
    );
    writeFileSync(sysctlPath, "1\n");

    const result = runInstaller(
      {
        "apt-get": 'echo "apt-get $*" >> "$COMMAND_LOG"',
        sudo: 'echo "sudo $*" >> "$COMMAND_LOG"; "$@"',
        timeout: 'echo "timeout $*" >> "$COMMAND_LOG"; shift 3; exec "$@"',
      },
      { CLAUDE_CODE_APPARMOR_USERNS_SYSCTL_PATH: sysctlPath },
    );

    expect(result.status).toBe(0);
    expect(result.log).toContain(
      "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(result.log).toContain(
      "\nsysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
    );
  });

  test("skips the AppArmor step when the sysctl does not exist", () => {
    const result = runInstaller(
      {
        "apt-get": 'echo "apt-get $*" >> "$COMMAND_LOG"',
        sudo: 'echo "sudo $*" >> "$COMMAND_LOG"; "$@"',
        timeout: 'echo "timeout $*" >> "$COMMAND_LOG"; shift 3; exec "$@"',
      },
      { CLAUDE_CODE_APPARMOR_USERNS_SYSCTL_PATH: "/nonexistent/sysctl" },
    );

    expect(result.status).toBe(0);
    expect(result.log).not.toContain("sysctl");
  });
});
