// extensions/models/launchd_daemon.ts
import { z } from "zod";
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
} from "./_lib/launchctl.ts";
import { extractVendor } from "./_lib/vendor.ts";
import {
  generatePlistXml,
  getPlistInfo,
  scanPlistDirectories,
  validatePlist,
} from "./_lib/plist.ts";

// ── Schemas ─────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  label: z.string().describe(
    "The launchd job label (e.g., com.example.mydaemon)",
  ),
  plistPath: z.string().optional().describe(
    "Path to the plist file. If omitted, searches standard launchd directories.",
  ),
  domain: z.enum(["system", "gui", "user"]).default("gui").describe(
    "The launchd domain (system, gui, user)",
  ),
});

const DaemonSchema = z.object({
  label: z.string(),
  status: z.string(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  plistPath: z.string().nullable(),
  domain: z.string(),
  syncedAt: z.string(),
}).passthrough();

const ListItemSchema = z.object({
  label: z.string(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  status: z.string(),
});

const VendorItemSchema = z.object({
  vendor: z.string(),
  daemonCount: z.number(),
  labels: z.array(z.string()),
});

const DetailSchema = z.object({
  label: z.string(),
  status: z.string(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  exitCodeExplanation: z.string(),
  program: z.string().nullable(),
  programArguments: z.array(z.string()),
  environmentVariables: z.record(z.string(), z.string()),
  machServices: z.array(z.string()),
  enabledState: z.string().nullable(),
  timeout: z.number().nullable(),
  onDemand: z.boolean().nullable(),
  keepAlive: z.boolean().nullable(),
  domain: z.string(),
  syncedAt: z.string(),
}).passthrough();

const LogsSchema = z.object({
  label: z.string(),
  lines: z.array(z.string()),
  lineCount: z.number(),
  level: z.string(),
  since: z.string(),
  queriedAt: z.string(),
});

const PlistInfoSchema = z.object({
  label: z.string(),
  path: z.string(),
  valid: z.boolean(),
  validationErrors: z.array(z.string()),
  program: z.string().nullable(),
  programArguments: z.array(z.string()),
  runAtLoad: z.boolean(),
  keepAlive: z.unknown().nullable(),
  startInterval: z.number().nullable(),
  startCalendarInterval: z.array(z.record(z.string(), z.number())).nullable(),
  watchPaths: z.array(z.string()),
  environmentVariables: z.record(z.string(), z.string()),
  workingDirectory: z.string().nullable(),
  standardOutPath: z.string().nullable(),
  standardErrorPath: z.string().nullable(),
  disabled: z.boolean(),
  rawKeys: z.array(z.string()),
  queriedAt: z.string(),
});

const ScanItemSchema = z.object({
  label: z.string(),
  path: z.string(),
  directory: z.string(),
  type: z.enum(["agent", "daemon"]),
  loaded: z.boolean(),
});

const OrphanSchema = z.object({
  label: z.string(),
  type: z.enum(["loaded_no_plist", "plist_not_loaded"]),
  path: z.string().nullable(),
  directory: z.string().nullable(),
});

const HealthItemSchema = z.object({
  label: z.string(),
  expected: z.string(),
  actual: z.string(),
  healthy: z.boolean(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  exitCodeExplanation: z.string(),
  plistPath: z.string().nullable(),
});

const ProcessInfoSchema = z.object({
  label: z.string(),
  pid: z.number(),
  cpu: z.number(),
  mem: z.number(),
  rss: z.number(),
  vsz: z.number(),
  command: z.string(),
});

const StartupItemSchema = z.object({
  label: z.string(),
  path: z.string(),
  type: z.enum(["agent", "daemon"]),
  runAtLoad: z.boolean(),
  keepAlive: z.unknown().nullable(),
  vendor: z.string(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getServiceTarget(globalArgs: { label: string; domain: string }) {
  const uid = await getUid();
  const target = domainTarget(globalArgs.domain, uid);
  return { uid, target, serviceTarget: `${target}/${globalArgs.label}` };
}

function resolvePath(
  globalArgs: { plistPath?: string; label: string },
  repoDir: string,
): string | null {
  if (globalArgs.plistPath) {
    return resolvePlistPath(globalArgs.plistPath, repoDir);
  }
  return findPlist(globalArgs.label);
}

// ── Model ───────────────────────────────────────────────────────────────────

/** The @bixu/launchd extension model for managing macOS launchd daemons. */
export const model = {
  type: "@bixu/launchd",
  version: "2026.03.20.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "daemon": {
      description: "Launchd daemon state",
      schema: DaemonSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "detail": {
      description: "Detailed daemon info from launchctl print",
      schema: DetailSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "logs": {
      description: "Daemon log output from unified logging",
      schema: LogsSchema,
      lifetime: "1d",
      garbageCollection: 3,
    },
    "plistInfo": {
      description: "Parsed plist file contents and validation",
      schema: PlistInfoSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "list": {
      description: "List of daemons matching filters",
      schema: z.object({
        items: z.array(ListItemSchema),
        pattern: z.string(),
        count: z.number(),
        queriedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "vendors": {
      description: "Daemons grouped by software vendor",
      schema: z.object({
        vendors: z.array(VendorItemSchema),
        totalVendors: z.number(),
        totalDaemons: z.number(),
        queriedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "scan": {
      description: "Discovered plist files on disk",
      schema: z.object({
        items: z.array(ScanItemSchema),
        count: z.number(),
        directories: z.array(z.string()),
        queriedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "orphans": {
      description:
        "Orphaned daemons (loaded without plist, or plist not loaded)",
      schema: z.object({
        items: z.array(OrphanSchema),
        count: z.number(),
        queriedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "health": {
      description: "Health check of daemons expected to be running",
      schema: z.object({
        items: z.array(HealthItemSchema),
        healthy: z.number(),
        unhealthy: z.number(),
        total: z.number(),
        queriedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "processes": {
      description: "Resource usage of running daemon processes",
      schema: z.object({
        items: z.array(ProcessInfoSchema),
        count: z.number(),
        totalCpu: z.number(),
        totalRss: z.number(),
        queriedAt: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 3,
    },
    "startup": {
      description: "Daemons configured to start at login/boot",
      schema: z.object({
        items: z.array(StartupItemSchema),
        count: z.number(),
        queriedAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },

  checks: {
    "launchctl-available": {
      description: "Verify launchctl is available on this system",
      labels: ["dependency"],
      execute: async () => {
        try {
          const result = await launchctl(["version"]);
          if (!result.success) {
            return {
              pass: false,
              errors: [
                "launchctl returned a non-zero exit code — is this macOS?",
              ],
            };
          }
          return { pass: true };
        } catch {
          return {
            pass: false,
            errors: ["launchctl not found — this model requires macOS"],
          };
        }
      },
    },
    "valid-domain": {
      description: "Verify the domain target is accessible",
      labels: ["dependency"],
      execute: async (context) => {
        const { target } = await getServiceTarget(context.globalArgs);
        const result = await launchctl(["print", target]);
        if (!result.success) {
          return {
            pass: false,
            errors: [
              `Cannot access domain "${target}": ${result.stderr.trim()}.`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },

  methods: {
    // ── Lifecycle ──────────────────────────────────────────────────────────

    load: {
      description: "Load (bootstrap) the daemon into launchd",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { target } = await getServiceTarget(context.globalArgs);
        const plistPath = resolvePath(context.globalArgs, context.repoDir);

        if (!plistPath) {
          throw new Error(
            `No plist found for label "${label}". Provide plistPath explicitly.`,
          );
        }

        const result = await launchctl(["bootstrap", target, plistPath]);
        if (!result.success) {
          if (
            result.stderr.includes("36:") ||
            result.stderr.includes("already loaded")
          ) {
            context.logger.info("Daemon {label} is already loaded", { label });
          } else {
            throw new Error(`Failed to load daemon: ${result.stderr.trim()}`);
          }
        }

        const statusResult = await launchctl(["print", `${target}/${label}`]);
        const parsed = parseServiceStatus(statusResult.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "loaded",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath,
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    unload: {
      description: "Unload (bootout) the daemon from launchd",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["bootout", serviceTarget]);
        if (!result.success) {
          if (
            result.stderr.includes("3:") ||
            result.stderr.includes("Could not find service")
          ) {
            context.logger.info("Daemon {label} is not loaded", { label });
          } else {
            throw new Error(`Failed to unload daemon: ${result.stderr.trim()}`);
          }
        }
        return { dataHandles: [] };
      },
    },

    enable: {
      description: "Enable the daemon (persists across reboots)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["enable", serviceTarget]);
        if (!result.success) {
          throw new Error(`Failed to enable daemon: ${result.stderr.trim()}`);
        }

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: "enabled",
          pid: null,
          exitCode: null,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    disable: {
      description:
        "Disable the daemon (persists across reboots, does not unload)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["disable", serviceTarget]);
        if (!result.success) {
          throw new Error(`Failed to disable daemon: ${result.stderr.trim()}`);
        }

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: "disabled",
          pid: null,
          exitCode: null,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    start: {
      description: "Start (kickstart) the daemon",
      arguments: z.object({
        force: z.boolean().default(false).describe(
          "Force restart even if already running (-k flag)",
        ),
      }),
      execute: async (args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const kickstartArgs = ["kickstart"];
        if (args.force) kickstartArgs.push("-k");
        kickstartArgs.push(serviceTarget);

        const result = await launchctl(kickstartArgs);
        if (!result.success) {
          throw new Error(`Failed to start daemon: ${result.stderr.trim()}`);
        }

        const statusResult = await launchctl(["print", serviceTarget]);
        const parsed = parseServiceStatus(statusResult.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "running",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop the daemon by sending SIGTERM",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["kill", "SIGTERM", serviceTarget]);
        if (!result.success && !result.stderr.includes("3:")) {
          throw new Error(`Failed to stop daemon: ${result.stderr.trim()}`);
        }

        const statusResult = await launchctl(["print", serviceTarget]);
        const parsed = parseServiceStatus(statusResult.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "stopped",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    restart: {
      description: "Restart the daemon (stop + start)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        // kickstart -k kills and restarts in one operation
        const result = await launchctl(["kickstart", "-k", serviceTarget]);
        if (!result.success) {
          throw new Error(`Failed to restart daemon: ${result.stderr.trim()}`);
        }

        const statusResult = await launchctl(["print", serviceTarget]);
        const parsed = parseServiceStatus(statusResult.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "running",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ── Observability ─────────────────────────────────────────────────────

    sync: {
      description: "Refresh stored daemon state from launchctl",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["print", serviceTarget]);
        const parsed = result.success
          ? parseServiceStatus(result.stdout)
          : { pid: null, exitCode: null, status: "not_found" };

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status,
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    detail: {
      description:
        "Get detailed daemon info: program, environment, mach services, limits",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["print", serviceTarget]);
        if (!result.success) {
          throw new Error(`Daemon not found: ${result.stderr.trim()}`);
        }

        const info = parseServiceDetail(result.stdout);

        const handle = await context.writeResource("detail", "main", {
          label,
          status: info.status,
          pid: info.pid,
          exitCode: info.exitCode,
          exitCodeExplanation: explainExitCode(info.exitCode),
          program: info.program,
          programArguments: info.programArguments,
          environmentVariables: info.environmentVariables,
          machServices: info.machServices,
          enabledState: info.enabledState,
          timeout: info.timeout,
          onDemand: info.onDemand,
          keepAlive: info.keepAlive,
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    blame: {
      description: "Show why and how the daemon was started",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["blame", serviceTarget]);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: result.success ? "loaded" : "not_found",
          pid: null,
          exitCode: null,
          plistPath: resolvePath(context.globalArgs, context.repoDir),
          domain,
          blame: result.stdout.trim(),
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    diagnose: {
      description:
        "Diagnose daemon issues: check exit codes, plist validity, loaded state",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);
        const plistPath = resolvePath(context.globalArgs, context.repoDir);

        const issues: string[] = [];

        // Check if loaded
        const printResult = await launchctl(["print", serviceTarget]);
        if (!printResult.success) {
          issues.push("Daemon is not loaded in launchd");
        } else {
          const info = parseServiceDetail(printResult.stdout);
          if (info.exitCode !== null && info.exitCode !== 0) {
            issues.push(
              `Last exit code ${info.exitCode}: ${
                explainExitCode(info.exitCode)
              }`,
            );
          }
          if (info.status === "waiting") {
            issues.push(
              "Daemon is in 'waiting' state — may be throttled after repeated crashes",
            );
          }
        }

        // Check plist
        if (plistPath) {
          try {
            const validation = await validatePlist(plistPath);
            if (!validation.valid) {
              issues.push(
                `Plist validation failed: ${validation.errors.join("; ")}`,
              );
            }
          } catch {
            issues.push(`Plist file not readable at ${plistPath}`);
          }
        } else {
          issues.push("No plist file found on disk");
        }

        const parsed = printResult.success
          ? parseServiceStatus(printResult.stdout)
          : { pid: null, exitCode: null, status: "not_found" };

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status,
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          exitCodeExplanation: explainExitCode(parsed.exitCode),
          plistPath,
          domain,
          issues,
          issueCount: issues.length,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    logs: {
      description: "Fetch daemon logs from macOS unified logging",
      arguments: z.object({
        lines: z.number().default(50).describe(
          "Max number of log lines to return",
        ),
        level: z.enum(["default", "info", "debug", "error", "fault"]).default(
          "default",
        ).describe("Minimum log level"),
        since: z.string().default("1h").describe(
          "Time window (e.g., 1h, 30m, 1d)",
        ),
      }),
      execute: async (args, context) => {
        const { label } = context.globalArgs;

        const result = await runCmd("log", [
          "show",
          "--predicate",
          `subsystem == "${label}" OR senderImagePath CONTAINS "${label}"`,
          "--style",
          "compact",
          "--last",
          args.since,
          "--info",
          ...(args.level === "debug" ? ["--debug"] : []),
        ]);

        const allLines = result.stdout.split("\n").filter((l) =>
          l.trim().length > 0
        );
        const lines = allLines.slice(-args.lines);

        const handle = await context.writeResource("logs", "main", {
          label,
          lines,
          lineCount: lines.length,
          level: args.level,
          since: args.since,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ── Plist Management ──────────────────────────────────────────────────

    plistInfo: {
      description: "Parse and validate the plist file for this daemon",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label } = context.globalArgs;
        const plistPath = resolvePath(context.globalArgs, context.repoDir);

        if (!plistPath) throw new Error(`No plist found for label "${label}"`);

        const [info, validation] = await Promise.all([
          getPlistInfo(plistPath),
          validatePlist(plistPath),
        ]);

        const handle = await context.writeResource("plistInfo", "main", {
          label: info.label,
          path: info.path,
          valid: validation.valid,
          validationErrors: validation.errors,
          program: info.program,
          programArguments: info.programArguments,
          runAtLoad: info.runAtLoad,
          keepAlive: info.keepAlive,
          startInterval: info.startInterval,
          startCalendarInterval: info.startCalendarInterval,
          watchPaths: info.watchPaths,
          environmentVariables: info.environmentVariables,
          workingDirectory: info.workingDirectory,
          standardOutPath: info.standardOutPath,
          standardErrorPath: info.standardErrorPath,
          disabled: info.disabled,
          rawKeys: info.rawKeys,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    createPlist: {
      description: "Generate a new plist file for a launchd daemon",
      arguments: z.object({
        outputPath: z.string().describe(
          "Path to write the plist file (relative to repo or absolute)",
        ),
        programArguments: z.array(z.string()).describe(
          "Command and arguments to run",
        ),
        runAtLoad: z.boolean().default(false),
        keepAlive: z.boolean().default(false),
        startInterval: z.number().optional().describe("Run every N seconds"),
        startCalendarInterval: z.record(z.string(), z.number()).optional()
          .describe("Cron-like schedule (Hour, Minute, Weekday, etc.)"),
        watchPaths: z.array(z.string()).optional().describe(
          "Paths to watch for changes",
        ),
        environmentVariables: z.record(z.string(), z.string()).optional(),
        workingDirectory: z.string().optional(),
        standardOutPath: z.string().optional(),
        standardErrorPath: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { label } = context.globalArgs;
        const outputPath = resolvePlistPath(args.outputPath, context.repoDir);

        const xml = generatePlistXml({
          label,
          programArguments: args.programArguments,
          runAtLoad: args.runAtLoad,
          keepAlive: args.keepAlive,
          startInterval: args.startInterval,
          startCalendarInterval: args.startCalendarInterval,
          watchPaths: args.watchPaths,
          environmentVariables: args.environmentVariables,
          workingDirectory: args.workingDirectory,
          standardOutPath: args.standardOutPath,
          standardErrorPath: args.standardErrorPath,
        });

        await Deno.writeTextFile(outputPath, xml);

        const validation = await validatePlist(outputPath);

        const handle = await context.writeResource("plistInfo", "main", {
          label,
          path: outputPath,
          valid: validation.valid,
          validationErrors: validation.errors,
          program: null,
          programArguments: args.programArguments,
          runAtLoad: args.runAtLoad,
          keepAlive: args.keepAlive,
          startInterval: args.startInterval ?? null,
          startCalendarInterval: args.startCalendarInterval
            ? [args.startCalendarInterval]
            : null,
          watchPaths: args.watchPaths ?? [],
          environmentVariables: args.environmentVariables ?? {},
          workingDirectory: args.workingDirectory ?? null,
          standardOutPath: args.standardOutPath ?? null,
          standardErrorPath: args.standardErrorPath ?? null,
          disabled: false,
          rawKeys: ["Label", "ProgramArguments"],
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ── Discovery ─────────────────────────────────────────────────────────

    list: {
      description:
        "List daemons loaded in the domain, filtered by status and pattern",
      arguments: z.object({
        pattern: z.string().default("").describe(
          "Filter pattern to match against labels",
        ),
        status: z.enum(["all", "running", "not running"]).default("all")
          .describe("Filter by daemon status"),
      }),
      execute: async (args, context) => {
        const { target } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["print", target]);
        if (!result.success) {
          throw new Error(`Failed to list daemons: ${result.stderr.trim()}`);
        }

        const items = parseServiceList(
          result.stdout,
          args.pattern || undefined,
          args.status,
        );

        const handle = await context.writeResource("list", "main", {
          items,
          pattern: args.pattern || "*",
          count: items.length,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    vendors: {
      description: "Report daemons grouped by software vendor",
      arguments: z.object({
        status: z.enum(["all", "running", "not running"]).default("running"),
      }),
      execute: async (args, context) => {
        const { target } = await getServiceTarget(context.globalArgs);

        const result = await launchctl(["print", target]);
        if (!result.success) {
          throw new Error(`Failed to list daemons: ${result.stderr.trim()}`);
        }

        const items = parseServiceList(result.stdout, undefined, args.status);
        const grouped: Record<string, string[]> = {};
        for (const item of items) {
          const vendor = extractVendor(item.label);
          if (!grouped[vendor]) grouped[vendor] = [];
          grouped[vendor].push(item.label);
        }

        const vendors = Object.entries(grouped)
          .map(([vendor, labels]) => ({
            vendor,
            daemonCount: labels.length,
            labels: labels.sort(),
          }))
          .sort((a, b) => b.daemonCount - a.daemonCount);

        const handle = await context.writeResource("vendors", "main", {
          vendors,
          totalVendors: vendors.length,
          totalDaemons: items.length,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    scan: {
      description:
        "Scan plist directories to discover all installed daemons (loaded or not)",
      arguments: z.object({
        pattern: z.string().default("").describe("Filter pattern for labels"),
      }),
      execute: async (args, context) => {
        const { target } = await getServiceTarget(context.globalArgs);

        // Get loaded services for cross-reference
        const printResult = await launchctl(["print", target]);
        const loadedLabels = new Set<string>();
        if (printResult.success) {
          for (const item of parseServiceList(printResult.stdout)) {
            loadedLabels.add(item.label);
          }
        }

        const discovered = await scanPlistDirectories(
          args.pattern || undefined,
        );
        const items = discovered.map((d) => ({
          ...d,
          loaded: loadedLabels.has(d.label),
        }));

        const handle = await context.writeResource("scan", "main", {
          items,
          count: items.length,
          directories: getPlistSearchDirs(),
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    orphans: {
      description:
        "Find orphaned daemons: loaded but no plist on disk, or plist exists but not loaded",
      arguments: z.object({
        pattern: z.string().default("").describe("Filter pattern for labels"),
      }),
      execute: async (args, context) => {
        const { target } = await getServiceTarget(context.globalArgs);

        // Get loaded services
        const printResult = await launchctl(["print", target]);
        const loadedLabels = new Set<string>();
        if (printResult.success) {
          for (
            const item of parseServiceList(
              printResult.stdout,
              args.pattern || undefined,
            )
          ) {
            loadedLabels.add(item.label);
          }
        }

        // Get plist files on disk
        const plists = await scanPlistDirectories(args.pattern || undefined);
        const plistLabels = new Map<
          string,
          { path: string; directory: string }
        >();
        for (const p of plists) {
          plistLabels.set(p.label, { path: p.path, directory: p.directory });
        }

        const orphans: Array<
          {
            label: string;
            type: "loaded_no_plist" | "plist_not_loaded";
            path: string | null;
            directory: string | null;
          }
        > = [];

        // Loaded but no plist
        for (const label of loadedLabels) {
          if (!plistLabels.has(label)) {
            orphans.push({
              label,
              type: "loaded_no_plist",
              path: null,
              directory: null,
            });
          }
        }

        // Plist exists but not loaded
        for (const [label, info] of plistLabels) {
          if (!loadedLabels.has(label)) {
            orphans.push({
              label,
              type: "plist_not_loaded",
              path: info.path,
              directory: info.directory,
            });
          }
        }

        orphans.sort((a, b) => a.label.localeCompare(b.label));

        const handle = await context.writeResource("orphans", "main", {
          items: orphans,
          count: orphans.length,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    diff: {
      description:
        "Compare plist on disk vs loaded state in launchd (drift detection)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const { serviceTarget } = await getServiceTarget(context.globalArgs);
        const plistPath = resolvePath(context.globalArgs, context.repoDir);

        const differences: Array<
          { field: string; plist: string; loaded: string }
        > = [];

        // Get loaded state
        const printResult = await launchctl(["print", serviceTarget]);
        if (!printResult.success) {
          throw new Error("Daemon not loaded — nothing to compare");
        }

        const loadedInfo = parseServiceDetail(printResult.stdout);

        // Get plist state
        if (!plistPath) throw new Error(`No plist found for "${label}"`);
        const plistInfo = await getPlistInfo(plistPath);

        // Compare program
        if (
          plistInfo.program && loadedInfo.program &&
          plistInfo.program !== loadedInfo.program
        ) {
          differences.push({
            field: "program",
            plist: plistInfo.program,
            loaded: loadedInfo.program,
          });
        }

        // Compare program arguments
        const plistArgs = JSON.stringify(plistInfo.programArguments);
        const loadedArgs = JSON.stringify(loadedInfo.programArguments);
        if (
          plistArgs !== loadedArgs && loadedInfo.programArguments.length > 0
        ) {
          differences.push({
            field: "programArguments",
            plist: plistArgs,
            loaded: loadedArgs,
          });
        }

        // Compare environment variables
        for (
          const [key, plistVal] of Object.entries(
            plistInfo.environmentVariables,
          )
        ) {
          const loadedVal = loadedInfo.environmentVariables[key];
          if (loadedVal !== undefined && loadedVal !== plistVal) {
            differences.push({
              field: `env.${key}`,
              plist: plistVal,
              loaded: loadedVal,
            });
          }
        }

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: loadedInfo.status,
          pid: loadedInfo.pid,
          exitCode: loadedInfo.exitCode,
          plistPath,
          domain,
          driftDetected: differences.length > 0,
          differences,
          differenceCount: differences.length,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    // ── Reporting ─────────────────────────────────────────────────────────

    health: {
      description:
        "Check health of daemons with KeepAlive or RunAtLoad that should be running",
      arguments: z.object({
        pattern: z.string().default("").describe("Filter pattern for labels"),
      }),
      execute: async (args, context) => {
        const { target } = await getServiceTarget(context.globalArgs);

        // Get loaded services
        const printResult = await launchctl(["print", target]);
        if (!printResult.success) {
          throw new Error(
            `Failed to query domain: ${printResult.stderr.trim()}`,
          );
        }
        const loaded = parseServiceList(
          printResult.stdout,
          args.pattern || undefined,
        );

        // Get plists to find which ones have KeepAlive or RunAtLoad
        const plists = await scanPlistDirectories(args.pattern || undefined);

        const healthItems: Array<{
          label: string;
          expected: string;
          actual: string;
          healthy: boolean;
          pid: number | null;
          exitCode: number | null;
          exitCodeExplanation: string;
          plistPath: string | null;
        }> = [];

        for (const plist of plists) {
          let info;
          try {
            info = await getPlistInfo(plist.path);
          } catch {
            continue;
          }

          if (!info.runAtLoad && info.keepAlive === null) continue;

          const expected = (info.runAtLoad || info.keepAlive === true)
            ? "running"
            : "idle";
          if (expected !== "running") continue;

          const loadedItem = loaded.find((l) => l.label === plist.label);
          const actual = loadedItem?.status ?? "not loaded";
          const healthy = actual === "running";

          healthItems.push({
            label: plist.label,
            expected,
            actual,
            healthy,
            pid: loadedItem?.pid ?? null,
            exitCode: loadedItem?.exitCode ?? null,
            exitCodeExplanation: explainExitCode(loadedItem?.exitCode ?? null),
            plistPath: plist.path,
          });
        }

        healthItems.sort((a, b) => {
          if (a.healthy !== b.healthy) return a.healthy ? 1 : -1; // unhealthy first
          return a.label.localeCompare(b.label);
        });

        const handle = await context.writeResource("health", "main", {
          items: healthItems,
          healthy: healthItems.filter((h) => h.healthy).length,
          unhealthy: healthItems.filter((h) => !h.healthy).length,
          total: healthItems.length,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    processes: {
      description: "Show CPU and memory usage for running daemon processes",
      arguments: z.object({
        pattern: z.string().default("").describe("Filter pattern for labels"),
      }),
      execute: async (args, context) => {
        const { target } = await getServiceTarget(context.globalArgs);

        const printResult = await launchctl(["print", target]);
        if (!printResult.success) {
          throw new Error(
            `Failed to query domain: ${printResult.stderr.trim()}`,
          );
        }

        const running = parseServiceList(
          printResult.stdout,
          args.pattern || undefined,
          "running",
        );
        const pids = running.filter((r) => r.pid && r.pid > 0).map((r) =>
          r.pid!
        );

        if (pids.length === 0) {
          const handle = await context.writeResource("processes", "main", {
            items: [],
            count: 0,
            totalCpu: 0,
            totalRss: 0,
            queriedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Get process info from ps
        const psResult = await runCmd("ps", [
          "-o",
          "pid=,pcpu=,pmem=,rss=,vsz=,command=",
          "-p",
          pids.join(","),
        ]);

        const pidToLabel = new Map<number, string>();
        for (const r of running) {
          if (r.pid) pidToLabel.set(r.pid, r.label);
        }

        const items: Array<{
          label: string;
          pid: number;
          cpu: number;
          mem: number;
          rss: number;
          vsz: number;
          command: string;
        }> = [];

        for (const line of psResult.stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split(/\s+/);
          if (parts.length < 6) continue;

          const pid = parseInt(parts[0], 10);
          const label = pidToLabel.get(pid);
          if (!label) continue;

          items.push({
            label,
            pid,
            cpu: parseFloat(parts[1]) || 0,
            mem: parseFloat(parts[2]) || 0,
            rss: parseInt(parts[3], 10) || 0,
            vsz: parseInt(parts[4], 10) || 0,
            command: parts.slice(5).join(" "),
          });
        }

        items.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);

        const handle = await context.writeResource("processes", "main", {
          items,
          count: items.length,
          totalCpu: Math.round(items.reduce((s, i) => s + i.cpu, 0) * 100) /
            100,
          totalRss: items.reduce((s, i) => s + i.rss, 0),
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    startup: {
      description:
        "Report all daemons configured to start at login/boot (RunAtLoad or KeepAlive)",
      arguments: z.object({
        pattern: z.string().default("").describe("Filter pattern for labels"),
      }),
      execute: async (args, _context) => {
        const plists = await scanPlistDirectories(args.pattern || undefined);

        const items: Array<{
          label: string;
          path: string;
          type: "agent" | "daemon";
          runAtLoad: boolean;
          keepAlive: unknown;
          vendor: string;
        }> = [];

        for (const plist of plists) {
          let info;
          try {
            info = await getPlistInfo(plist.path);
          } catch {
            continue;
          }

          if (!info.runAtLoad && info.keepAlive === null) continue;

          items.push({
            label: plist.label,
            path: plist.path,
            type: plist.type,
            runAtLoad: info.runAtLoad,
            keepAlive: info.keepAlive,
            vendor: extractVendor(plist.label),
          });
        }

        items.sort((a, b) =>
          a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label)
        );

        const handle = await _context.writeResource("startup", "main", {
          items,
          count: items.length,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
