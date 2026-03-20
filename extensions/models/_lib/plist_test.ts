import { assertEquals, assertRejects } from "@std/assert";
import {
  generatePlistXml,
  getPlistInfo,
  parsePlistData,
  readPlist,
  scanPlistDirectories,
  validatePlist,
} from "./plist.ts";

// ── parsePlistData ──────────────────────────────────────────────────────────

Deno.test("parsePlistData extracts basic fields", () => {
  const data = {
    Label: "com.example.test",
    Program: "/usr/bin/test",
    ProgramArguments: ["/usr/bin/test", "-v"],
    RunAtLoad: true,
    KeepAlive: false,
  };
  const info = parsePlistData(data, "/path/to/plist");
  assertEquals(info.label, "com.example.test");
  assertEquals(info.program, "/usr/bin/test");
  assertEquals(info.programArguments, ["/usr/bin/test", "-v"]);
  assertEquals(info.runAtLoad, true);
  assertEquals(info.keepAlive, false);
  assertEquals(info.path, "/path/to/plist");
});

Deno.test("parsePlistData handles missing optional fields", () => {
  const data = { Label: "com.example.minimal" };
  const info = parsePlistData(data, "/path");
  assertEquals(info.label, "com.example.minimal");
  assertEquals(info.program, null);
  assertEquals(info.programArguments, []);
  assertEquals(info.runAtLoad, false);
  assertEquals(info.keepAlive, null);
  assertEquals(info.startInterval, null);
  assertEquals(info.startCalendarInterval, null);
  assertEquals(info.watchPaths, []);
  assertEquals(info.environmentVariables, {});
  assertEquals(info.workingDirectory, null);
  assertEquals(info.standardOutPath, null);
  assertEquals(info.standardErrorPath, null);
  assertEquals(info.disabled, false);
});

Deno.test("parsePlistData handles single StartCalendarInterval dict", () => {
  const data = {
    Label: "com.example.cron",
    StartCalendarInterval: { Hour: 3, Minute: 30 },
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.startCalendarInterval, [{ Hour: 3, Minute: 30 }]);
});

Deno.test("parsePlistData handles array of StartCalendarInterval", () => {
  const data = {
    Label: "com.example.multicron",
    StartCalendarInterval: [
      { Hour: 3, Minute: 0 },
      { Hour: 15, Minute: 0 },
    ],
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.startCalendarInterval, [
    { Hour: 3, Minute: 0 },
    { Hour: 15, Minute: 0 },
  ]);
});

Deno.test("parsePlistData extracts environment variables", () => {
  const data = {
    Label: "com.example.env",
    EnvironmentVariables: { HOME: "/Users/test", DEBUG: "1" },
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.environmentVariables, { HOME: "/Users/test", DEBUG: "1" });
});

Deno.test("parsePlistData extracts watch paths", () => {
  const data = {
    Label: "com.example.watcher",
    WatchPaths: ["/tmp/trigger", "/var/log/app.log"],
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.watchPaths, ["/tmp/trigger", "/var/log/app.log"]);
});

Deno.test("parsePlistData extracts IO paths", () => {
  const data = {
    Label: "com.example.io",
    StandardOutPath: "/var/log/out.log",
    StandardErrorPath: "/var/log/err.log",
    WorkingDirectory: "/opt/app",
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.standardOutPath, "/var/log/out.log");
  assertEquals(info.standardErrorPath, "/var/log/err.log");
  assertEquals(info.workingDirectory, "/opt/app");
});

Deno.test("parsePlistData extracts rawKeys", () => {
  const data = {
    Label: "com.example.keys",
    Program: "/bin/test",
    RunAtLoad: true,
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.rawKeys.sort(), ["Label", "Program", "RunAtLoad"]);
});

Deno.test("parsePlistData handles KeepAlive as dict", () => {
  const data = {
    Label: "com.example.keepalive",
    KeepAlive: { SuccessfulExit: false },
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.keepAlive, { SuccessfulExit: false });
});

Deno.test("parsePlistData handles Disabled flag", () => {
  const data = {
    Label: "com.example.disabled",
    Disabled: true,
  };
  const info = parsePlistData(data, "/path");
  assertEquals(info.disabled, true);
});

// ── generatePlistXml ────────────────────────────────────────────────────────

Deno.test("generatePlistXml generates minimal plist", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/echo", "hello"],
  });
  assertEquals(xml.includes("<string>com.example.test</string>"), true);
  assertEquals(xml.includes("<string>/bin/echo</string>"), true);
  assertEquals(xml.includes("<string>hello</string>"), true);
  assertEquals(xml.includes('<?xml version="1.0"'), true);
  assertEquals(xml.includes("</plist>"), true);
});

Deno.test("generatePlistXml includes RunAtLoad", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    runAtLoad: true,
  });
  assertEquals(xml.includes("<key>RunAtLoad</key>"), true);
  assertEquals(xml.includes("<true/>"), true);
});

Deno.test("generatePlistXml includes KeepAlive", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    keepAlive: true,
  });
  assertEquals(xml.includes("<key>KeepAlive</key>"), true);
});

Deno.test("generatePlistXml includes StartInterval", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    startInterval: 300,
  });
  assertEquals(xml.includes("<key>StartInterval</key>"), true);
  assertEquals(xml.includes("<integer>300</integer>"), true);
});

Deno.test("generatePlistXml includes StartCalendarInterval", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    startCalendarInterval: { Hour: 3, Minute: 30 },
  });
  assertEquals(xml.includes("<key>StartCalendarInterval</key>"), true);
  assertEquals(xml.includes("<key>Hour</key>"), true);
  assertEquals(xml.includes("<integer>3</integer>"), true);
});

Deno.test("generatePlistXml includes environment variables", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    environmentVariables: { DEBUG: "1", HOME: "/Users/test" },
  });
  assertEquals(xml.includes("<key>EnvironmentVariables</key>"), true);
  assertEquals(xml.includes("<key>DEBUG</key>"), true);
  assertEquals(xml.includes("<string>1</string>"), true);
});

Deno.test("generatePlistXml includes watch paths", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    watchPaths: ["/tmp/trigger"],
  });
  assertEquals(xml.includes("<key>WatchPaths</key>"), true);
  assertEquals(xml.includes("<string>/tmp/trigger</string>"), true);
});

Deno.test("generatePlistXml includes IO paths", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/true"],
    standardOutPath: "/var/log/out.log",
    standardErrorPath: "/var/log/err.log",
    workingDirectory: "/opt/app",
  });
  assertEquals(xml.includes("<key>StandardOutPath</key>"), true);
  assertEquals(xml.includes("<key>StandardErrorPath</key>"), true);
  assertEquals(xml.includes("<key>WorkingDirectory</key>"), true);
});

Deno.test("generatePlistXml includes Program", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    program: "/usr/bin/test",
    programArguments: [],
  });
  assertEquals(xml.includes("<key>Program</key>"), true);
  assertEquals(xml.includes("<string>/usr/bin/test</string>"), true);
});

Deno.test("generatePlistXml escapes XML special characters", () => {
  const xml = generatePlistXml({
    label: "com.example.test",
    programArguments: ["/bin/echo", 'hello & "world" <tag>'],
  });
  assertEquals(
    xml.includes(
      "<string>hello &amp; &quot;world&quot; &lt;tag&gt;</string>",
    ),
    true,
  );
});

Deno.test("generatePlistXml omits empty optional sections", () => {
  const xml = generatePlistXml({
    label: "com.example.minimal",
    programArguments: ["/bin/true"],
  });
  assertEquals(xml.includes("EnvironmentVariables"), false);
  assertEquals(xml.includes("WatchPaths"), false);
  assertEquals(xml.includes("StandardOutPath"), false);
  assertEquals(xml.includes("StartInterval"), false);
  assertEquals(xml.includes("<key>Program</key>"), false);
});

// ── readPlist (I/O) ─────────────────────────────────────────────────────────

Deno.test("readPlist reads a known system plist", async () => {
  const data = await readPlist(
    "/System/Library/LaunchAgents/com.apple.AirPortBaseStationAgent.plist",
  );
  assertEquals(typeof data.Label, "string");
  assertEquals((data.Label as string).length > 0, true);
});

Deno.test("readPlist throws for nonexistent file", async () => {
  await assertRejects(
    () => readPlist("/nonexistent/path.plist"),
    Error,
  );
});

// ── validatePlist (I/O) ─────────────────────────────────────────────────────

Deno.test("validatePlist validates a known good plist", async () => {
  const result = await validatePlist(
    "/System/Library/LaunchAgents/com.apple.AirPortBaseStationAgent.plist",
  );
  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("validatePlist reports errors for invalid file", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".plist" });
  try {
    await Deno.writeTextFile(tmpFile, "this is not valid plist xml");
    const result = await validatePlist(tmpFile);
    assertEquals(result.valid, false);
    assertEquals(result.errors.length > 0, true);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// ── getPlistInfo (I/O) ──────────────────────────────────────────────────────

Deno.test("getPlistInfo parses a known system plist", async () => {
  const info = await getPlistInfo(
    "/System/Library/LaunchAgents/com.apple.AirPortBaseStationAgent.plist",
  );
  assertEquals(typeof info.label, "string");
  assertEquals(info.label.length > 0, true);
  assertEquals(
    info.path,
    "/System/Library/LaunchAgents/com.apple.AirPortBaseStationAgent.plist",
  );
  assertEquals(Array.isArray(info.rawKeys), true);
  assertEquals(info.rawKeys.includes("Label"), true);
});

// ── generatePlistXml + validatePlist round-trip ─────────────────────────────

Deno.test("generatePlistXml produces valid plist XML", async () => {
  const xml = generatePlistXml({
    label: "com.test.roundtrip",
    programArguments: ["/bin/echo", "hello"],
    runAtLoad: false,
    keepAlive: false,
    startInterval: 60,
    environmentVariables: { FOO: "bar" },
  });
  const tmpFile = await Deno.makeTempFile({ suffix: ".plist" });
  try {
    await Deno.writeTextFile(tmpFile, xml);
    const result = await validatePlist(tmpFile);
    assertEquals(
      result.valid,
      true,
      `Generated XML failed validation: ${result.errors.join(", ")}`,
    );

    // Round-trip: read it back and verify
    const data = await readPlist(tmpFile);
    assertEquals(data.Label, "com.test.roundtrip");
    assertEquals(data.StartInterval, 60);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// ── scanPlistDirectories (I/O) ──────────────────────────────────────────────

Deno.test("scanPlistDirectories finds plists on disk", async () => {
  const results = await scanPlistDirectories();
  assertEquals(results.length > 0, true);
  assertEquals(results[0].path.endsWith(".plist"), true);
  assertEquals(results[0].label.length > 0, true);
});

Deno.test("scanPlistDirectories filters by pattern", async () => {
  const all = await scanPlistDirectories();
  const filtered = await scanPlistDirectories("com.apple");
  assertEquals(filtered.length > 0, true);
  assertEquals(filtered.length < all.length, true);
  assertEquals(filtered.every((p) => p.label.includes("com.apple")), true);
});

Deno.test("scanPlistDirectories classifies agents vs daemons", async () => {
  const results = await scanPlistDirectories();
  const agents = results.filter((r) => r.type === "agent");
  const daemons = results.filter((r) => r.type === "daemon");
  assertEquals(agents.length > 0, true);
  assertEquals(daemons.length > 0, true);
});

Deno.test("scanPlistDirectories returns case-insensitive sorted results", async () => {
  const results = await scanPlistDirectories();
  const labels = results.map((r) => r.label);
  const expected = [...labels].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" })
  );
  assertEquals(labels, expected);
});

Deno.test("scanPlistDirectories returns empty for impossible pattern", async () => {
  const results = await scanPlistDirectories("zzz-nonexistent-pattern-zzz");
  assertEquals(results.length, 0);
});
