import { assertEquals, assertNotEquals } from "@std/assert";
import {
  domainTarget,
  explainExitCode,
  findPlist,
  getPlistSearchDirs,
  getUid,
  launchctl,
  parseServiceDetail,
  parseServiceList,
  parseServiceStatus,
  resolvePlistPath,
  runCmd,
} from "./launchctl.ts";

// ── domainTarget ────────────────────────────────────────────────────────────

Deno.test("domainTarget returns 'system' for system domain", () => {
  assertEquals(domainTarget("system", "501"), "system");
});

Deno.test("domainTarget returns gui/<uid> for gui domain", () => {
  assertEquals(domainTarget("gui", "501"), "gui/501");
});

Deno.test("domainTarget returns user/<uid> for user domain", () => {
  assertEquals(domainTarget("user", "501"), "user/501");
});

Deno.test("domainTarget defaults to gui/<uid> for unknown domain", () => {
  assertEquals(domainTarget("bogus", "501"), "gui/501");
});

// ── resolvePlistPath ────────────────────────────────────────────────────────

Deno.test("resolvePlistPath returns absolute paths unchanged", () => {
  assertEquals(
    resolvePlistPath("/absolute/path.plist", "/repo"),
    "/absolute/path.plist",
  );
});

Deno.test("resolvePlistPath resolves relative paths against repoDir", () => {
  assertEquals(
    resolvePlistPath("fixtures/test.plist", "/repo"),
    "/repo/fixtures/test.plist",
  );
});

// ── parseServiceStatus ──────────────────────────────────────────────────────

Deno.test("parseServiceStatus parses running service", () => {
  const output = `
    com.example.daemon = {
      active count = 1
      pid = 12345
      state = running
      last exit code = 0
    }
  `;
  const result = parseServiceStatus(output);
  assertEquals(result.pid, 12345);
  assertEquals(result.exitCode, 0);
  assertEquals(result.status, "running");
});

Deno.test("parseServiceStatus parses service with no pid", () => {
  const output = `
    com.example.daemon = {
      active count = 0
      state = waiting
      last exit code = 78
    }
  `;
  const result = parseServiceStatus(output);
  assertEquals(result.pid, null);
  assertEquals(result.exitCode, 78);
  assertEquals(result.status, "waiting");
});

Deno.test("parseServiceStatus handles (null) values", () => {
  const output = `
    pid = (null)
    exit code = (null)
    state = not running
  `;
  const result = parseServiceStatus(output);
  assertEquals(result.pid, null);
  assertEquals(result.exitCode, null);
  assertEquals(result.status, "not running");
});

Deno.test("parseServiceStatus returns defaults for empty output", () => {
  const result = parseServiceStatus("");
  assertEquals(result.pid, null);
  assertEquals(result.exitCode, null);
  assertEquals(result.status, "unknown");
});

// ── parseServiceDetail ──────────────────────────────────────────────────────

Deno.test("parseServiceDetail parses program and arguments", () => {
  const output = `
    program = /usr/bin/ssh-agent
    arguments = {
      /usr/bin/ssh-agent
      -l
    }
    state = running
    pid = 456
  `;
  const result = parseServiceDetail(output);
  assertEquals(result.program, "/usr/bin/ssh-agent");
  assertEquals(result.programArguments, ["/usr/bin/ssh-agent", "-l"]);
  assertEquals(result.status, "running");
  assertEquals(result.pid, 456);
});

Deno.test("parseServiceDetail parses environment variables", () => {
  const output = `
    state = running
    environment = {
      HOME => /Users/test
      PATH => /usr/bin
    }
  `;
  const result = parseServiceDetail(output);
  assertEquals(result.environmentVariables, {
    HOME: "/Users/test",
    PATH: "/usr/bin",
  });
});

Deno.test("parseServiceDetail parses mach services", () => {
  const output = `
    state = running
    machservices = {
      com.example.service = true
      com.example.other = true
    }
  `;
  const result = parseServiceDetail(output);
  assertEquals(result.machServices, [
    "com.example.service",
    "com.example.other",
  ]);
});

Deno.test("parseServiceDetail parses endpoints section", () => {
  const output = `
    state = running
    endpoints = {
      com.example.endpoint = true
    }
  `;
  const result = parseServiceDetail(output);
  assertEquals(result.machServices, ["com.example.endpoint"]);
});

Deno.test("parseServiceDetail parses enabled state and flags", () => {
  const output = `
    state = running
    enabled = true
    timeout = 30
    on-demand = true
    keep alive = true
    runs in background = false
  `;
  const result = parseServiceDetail(output);
  assertEquals(result.enabledState, "true");
  assertEquals(result.timeout, 30);
  assertEquals(result.onDemand, true);
  assertEquals(result.keepAlive, true);
  assertEquals(result.runsInBackground, false);
});

Deno.test("parseServiceDetail returns nulls for missing fields", () => {
  const output = `state = waiting`;
  const result = parseServiceDetail(output);
  assertEquals(result.program, null);
  assertEquals(result.programArguments, []);
  assertEquals(result.environmentVariables, {});
  assertEquals(result.machServices, []);
  assertEquals(result.enabledState, null);
  assertEquals(result.timeout, null);
  assertEquals(result.onDemand, null);
  assertEquals(result.keepAlive, null);
});

Deno.test("parseServiceDetail parses 'keepalive' alternate spelling", () => {
  const output = `
    state = running
    keepalive = 1
  `;
  const result = parseServiceDetail(output);
  assertEquals(result.keepAlive, true);
});

// ── parseServiceList ────────────────────────────────────────────────────────

const SAMPLE_SERVICE_LIST = `
com.apple.xpc.launchd.domain.gui = {
  type = 7
  handle = 0
  services = {
    501  0  com.apple.Finder
    -    0  com.apple.Dock
    789  -  com.docker.docker
    -    1  com.example.crashed
  }
}
`;

Deno.test("parseServiceList parses all services", () => {
  const items = parseServiceList(SAMPLE_SERVICE_LIST);
  assertEquals(items.length, 4);
});

Deno.test("parseServiceList identifies running vs not running", () => {
  const items = parseServiceList(SAMPLE_SERVICE_LIST);
  const finder = items.find((i) => i.label === "com.apple.Finder");
  const dock = items.find((i) => i.label === "com.apple.Dock");
  assertEquals(finder?.status, "running");
  assertEquals(finder?.pid, 501);
  assertEquals(dock?.status, "not running");
  assertEquals(dock?.pid, null);
});

Deno.test("parseServiceList filters by pattern", () => {
  const items = parseServiceList(SAMPLE_SERVICE_LIST, "com.apple");
  assertEquals(items.length, 2);
  assertEquals(items[0].label, "com.apple.Dock");
  assertEquals(items[1].label, "com.apple.Finder");
});

Deno.test("parseServiceList filters by status", () => {
  const running = parseServiceList(
    SAMPLE_SERVICE_LIST,
    undefined,
    "running",
  );
  assertEquals(running.length, 2);
  assertEquals(running.every((i) => i.status === "running"), true);

  const notRunning = parseServiceList(
    SAMPLE_SERVICE_LIST,
    undefined,
    "not running",
  );
  assertEquals(notRunning.length, 2);
});

Deno.test("parseServiceList combines pattern and status filters", () => {
  const items = parseServiceList(
    SAMPLE_SERVICE_LIST,
    "com.apple",
    "running",
  );
  assertEquals(items.length, 1);
  assertEquals(items[0].label, "com.apple.Finder");
});

Deno.test("parseServiceList parses exit codes", () => {
  const items = parseServiceList(SAMPLE_SERVICE_LIST);
  const crashed = items.find((i) => i.label === "com.example.crashed");
  assertEquals(crashed?.exitCode, 1);
  const docker = items.find((i) => i.label === "com.docker.docker");
  assertEquals(docker?.exitCode, null);
});

Deno.test("parseServiceList sorts by label", () => {
  const items = parseServiceList(SAMPLE_SERVICE_LIST);
  const labels = items.map((i) => i.label);
  assertEquals(labels, [...labels].sort());
});

Deno.test("parseServiceList handles empty services block", () => {
  const output = `
    services = {
    }
  `;
  assertEquals(parseServiceList(output), []);
});

Deno.test("parseServiceList handles non-numeric PID and exit code", () => {
  const output = `
    services = {
      abc  xyz  com.example.weird
    }
  `;
  const items = parseServiceList(output);
  assertEquals(items.length, 1);
  assertEquals(items[0].pid, null);
  assertEquals(items[0].exitCode, null);
  assertEquals(items[0].status, "not running");
});

// ── explainExitCode ─────────────────────────────────────────────────────────

Deno.test("explainExitCode returns explanation for known codes", () => {
  assertEquals(explainExitCode(0), "Success");
  assertEquals(explainExitCode(1), "General error");
  assertEquals(explainExitCode(78), "Configuration error (EX_CONFIG)");
  assertEquals(explainExitCode(127), "Command not found");
  assertEquals(
    explainExitCode(137),
    "Killed by SIGKILL (9)",
  );
  assertEquals(
    explainExitCode(143),
    "Killed by SIGTERM (15) — normal termination",
  );
});

Deno.test("explainExitCode handles unknown signal codes", () => {
  assertEquals(explainExitCode(142), "Killed by signal 14");
});

Deno.test("explainExitCode handles unknown non-signal codes", () => {
  assertEquals(explainExitCode(42), "Unknown exit code 42");
});

Deno.test("explainExitCode handles null", () => {
  assertEquals(explainExitCode(null), "No exit code recorded");
});

// ── getUid ──────────────────────────────────────────────────────────────────

Deno.test("getUid returns a numeric uid", async () => {
  const uid = await getUid();
  assertEquals(/^\d+$/.test(uid), true);
});

// ── runCmd ──────────────────────────────────────────────────────────────────

Deno.test("runCmd executes a command and returns output", async () => {
  const result = await runCmd("echo", ["hello"]);
  assertEquals(result.success, true);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), "hello");
  assertEquals(result.stderr, "");
});

Deno.test("runCmd returns failure for bad commands", async () => {
  const result = await runCmd("false", []);
  assertEquals(result.success, false);
  assertNotEquals(result.code, 0);
});

// ── launchctl ───────────────────────────────────────────────────────────────

Deno.test("launchctl version returns successfully", async () => {
  const result = await launchctl(["version"]);
  assertEquals(result.success, true);
  assertEquals(result.stdout.length > 0, true);
});

Deno.test("launchctl returns failure for invalid subcommand", async () => {
  const result = await launchctl(["this-is-not-a-subcommand"]);
  assertEquals(result.success, false);
});

// ── getPlistSearchDirs ──────────────────────────────────────────────────────

Deno.test("getPlistSearchDirs returns standard macOS directories", () => {
  const dirs = getPlistSearchDirs();
  assertEquals(dirs.length, 5);
  assertEquals(dirs.some((d) => d.includes("LaunchAgents")), true);
  assertEquals(dirs.some((d) => d.includes("LaunchDaemons")), true);
  assertEquals(dirs[0].includes("Library/LaunchAgents"), true);
});

// ── findPlist ───────────────────────────────────────────────────────────────

Deno.test("findPlist finds a known system plist", () => {
  const path = findPlist("com.openssh.ssh-agent");
  assertNotEquals(path, null);
  assertEquals(path!.endsWith("com.openssh.ssh-agent.plist"), true);
});

Deno.test("findPlist returns null for nonexistent label", () => {
  const path = findPlist("com.nonexistent.this-does-not-exist-anywhere");
  assertEquals(path, null);
});
