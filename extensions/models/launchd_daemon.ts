// extensions/models/launchd_daemon.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  label: z.string().describe("The launchd job label (e.g., com.example.mydaemon)"),
  plistPath: z.string().optional().describe("Path to the plist file. If omitted, searches standard launchd directories."),
  domain: z.enum(["system", "gui", "user"]).default("gui").describe("The launchd domain (system, gui, user)"),
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

type DaemonData = z.infer<typeof DaemonSchema>;

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

// Known reverse-DNS prefix → friendly vendor name
const VENDOR_MAP: Record<string, string> = {
  "com.apple": "Apple",
  "com.google": "Google",
  "com.microsoft": "Microsoft",
  "com.docker": "Docker",
  "com.spotify": "Spotify",
  "com.dropbox": "Dropbox",
  "com.adobe": "Adobe",
  "com.brave": "Brave",
  "com.github": "GitHub",
  "com.slack": "Slack",
  "com.1password": "1Password",
  "com.agilebits": "1Password (AgileBits)",
  "com.zoom": "Zoom",
  "com.jetbrains": "JetBrains",
  "com.sublimetext": "Sublime Text",
  "com.sublimehq": "Sublime HQ",
  "com.notion": "Notion",
  "com.figma": "Figma",
  "com.linear": "Linear",
  "com.logi": "Logitech",
  "com.logitech": "Logitech",
  "com.raycast": "Raycast",
  "com.bartender": "Bartender",
  "com.cloudflare": "Cloudflare",
  "com.crowdstrike": "CrowdStrike",
  "com.sentinelone": "SentinelOne",
  "com.nordvpn": "NordVPN",
  "com.expressvpn": "ExpressVPN",
  "io.tailscale": "Tailscale",
  "org.mozilla": "Mozilla",
  "org.chromium": "Chromium",
  "org.pqrs": "Karabiner-Elements",
  "net.telestream": "Telestream",
  "app.tuple": "Tuple",
  "ai.perplexity": "Perplexity",
  "dev.warp": "Warp",
  "co.teamport": "Teamport",
};

function extractVendor(label: string): string {
  // Strip "application." prefix used for GUI apps
  let cleaned = label;
  if (cleaned.startsWith("application.")) {
    cleaned = cleaned.slice("application.".length);
  }

  // Check known vendor map (longest prefix match)
  const prefixes = Object.keys(VENDOR_MAP).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (cleaned.startsWith(prefix + ".") || cleaned === prefix) {
      return VENDOR_MAP[prefix];
    }
  }

  // Also check with "2BUA8C4S2C." prefix (Apple App Store team ID for 1Password)
  if (cleaned.startsWith("2BUA8C4S2C.com.1password")) return "1Password";

  // Fall back to extracting from reverse-DNS: take first two segments
  const parts = cleaned.split(".");
  if (parts.length >= 2) {
    const tld = parts[0];
    const org = parts[1];
    // Capitalize the org name
    return org.charAt(0).toUpperCase() + org.slice(1) + ` (${tld}.${org})`;
  }

  return cleaned;
}

async function getUid(): Promise<string> {
  const cmd = new Deno.Command("id", { args: ["-u"], stdout: "piped", stderr: "piped" });
  const output = await cmd.output();
  return new TextDecoder().decode(output.stdout).trim();
}

function domainTarget(domain: string, uid: string): string {
  switch (domain) {
    case "system":
      return "system";
    case "gui":
      return `gui/${uid}`;
    case "user":
      return `user/${uid}`;
    default:
      return `gui/${uid}`;
  }
}

function findPlist(label: string): string | null {
  const searchDirs = [
    `${Deno.env.get("HOME")}/Library/LaunchAgents`,
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
    "/System/Library/LaunchAgents",
    "/System/Library/LaunchDaemons",
  ];
  const fileName = `${label}.plist`;
  for (const dir of searchDirs) {
    const path = `${dir}/${fileName}`;
    try {
      Deno.statSync(path);
      return path;
    } catch {
      // not found, continue
    }
  }
  return null;
}

function resolvePlistPath(plistPath: string, repoDir: string): string {
  if (plistPath.startsWith("/")) return plistPath;
  return `${repoDir}/${plistPath}`;
}

async function launchctl(args: string[]): Promise<{ stdout: string; stderr: string; success: boolean; code: number }> {
  const cmd = new Deno.Command("launchctl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.success,
    code: output.code,
  };
}

function parseStatus(stdout: string): { pid: number | null; exitCode: number | null; status: string } {
  let pid: number | null = null;
  let exitCode: number | null = null;
  let status = "unknown";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("pid =")) {
      const val = trimmed.split("=")[1]?.trim();
      if (val && val !== "(null)") pid = parseInt(val, 10);
    }
    if (trimmed.startsWith("last exit code =") || trimmed.startsWith("exit code =")) {
      const val = trimmed.split("=")[1]?.trim();
      if (val && val !== "(null)") exitCode = parseInt(val, 10);
    }
    if (trimmed.startsWith("state =")) {
      status = trimmed.split("=")[1]?.trim() ?? "unknown";
    }
  }

  return { pid, exitCode, status };
}

export const model = {
  type: "@bixu/launchd-daemon",
  version: "2026.03.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "daemon": {
      description: "Launchd daemon state",
      schema: DaemonSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "list": {
      description: "List of discovered daemons matching a pattern",
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
  },
  checks: {
    "launchctl-available": {
      description: "Verify launchctl is available on this system",
      labels: ["dependency"],
      execute: async (_context) => {
        try {
          const cmd = new Deno.Command("launchctl", {
            args: ["version"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            return { pass: false, errors: ["launchctl returned a non-zero exit code — is this macOS?"] };
          }
          return { pass: true };
        } catch {
          return { pass: false, errors: ["launchctl not found — this model requires macOS"] };
        }
      },
    },
    "valid-domain": {
      description: "Verify the domain target is accessible",
      labels: ["dependency"],
      execute: async (context) => {
        const { domain } = context.globalArgs;
        const uid = await getUid();
        const target = domainTarget(domain, uid);
        const result = await launchctl(["print", target]);
        if (!result.success) {
          return {
            pass: false,
            errors: [`Cannot access domain "${target}": ${result.stderr.trim()}. You may need elevated privileges for the system domain.`],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    load: {
      description: "Load (bootstrap) the daemon into launchd",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        let plistPath = context.globalArgs.plistPath;
        const uid = await getUid();
        const target = domainTarget(domain, uid);

        if (!plistPath) {
          plistPath = findPlist(label);
          if (!plistPath) {
            throw new Error(
              `No plist found for label "${label}". Searched ~/Library/LaunchAgents, /Library/LaunchAgents, /Library/LaunchDaemons. Provide plistPath explicitly.`,
            );
          }
        } else {
          plistPath = resolvePlistPath(plistPath, context.repoDir);
        }

        const result = await launchctl(["bootstrap", target, plistPath]);

        if (!result.success) {
          if (result.stderr.includes("36: Operation now in progress") || result.stderr.includes("already loaded")) {
            context.logger.info("Daemon {label} is already loaded", { label });
          } else {
            throw new Error(`Failed to load daemon: ${result.stderr.trim()}`);
          }
        }

        // Get status after loading
        const statusResult = await launchctl(["print", `${target}/${label}`]);
        const parsed = parseStatus(statusResult.stdout);

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
        const { label, domain } = context.globalArgs;
        const uid = await getUid();
        const target = domainTarget(domain, uid);

        const result = await launchctl(["bootout", `${target}/${label}`]);

        if (!result.success) {
          if (result.stderr.includes("3: No such process") || result.stderr.includes("Could not find service")) {
            context.logger.info("Daemon {label} is not loaded", { label });
          } else {
            throw new Error(`Failed to unload daemon: ${result.stderr.trim()}`);
          }
        }

        return { dataHandles: [] };
      },
    },
    start: {
      description: "Start (kickstart) the daemon",
      arguments: z.object({
        force: z.boolean().default(false).describe("Force start even if already running (-k flag)"),
      }),
      execute: async (args, context) => {
        const { label, domain } = context.globalArgs;
        const uid = await getUid();
        const target = domainTarget(domain, uid);
        const serviceTarget = `${target}/${label}`;

        const kickstartArgs = ["kickstart"];
        if (args.force) kickstartArgs.push("-k");
        kickstartArgs.push(serviceTarget);

        const result = await launchctl(kickstartArgs);

        if (!result.success) {
          throw new Error(`Failed to start daemon: ${result.stderr.trim()}`);
        }

        // Get status after starting
        const statusResult = await launchctl(["print", serviceTarget]);
        const parsed = parseStatus(statusResult.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "running",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: context.globalArgs.plistPath || findPlist(label),
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
        const uid = await getUid();
        const target = domainTarget(domain, uid);
        const serviceTarget = `${target}/${label}`;

        const result = await launchctl(["kill", "SIGTERM", serviceTarget]);

        if (!result.success) {
          if (result.stderr.includes("3: No such process")) {
            context.logger.info("Daemon {label} is not running", { label });
          } else {
            throw new Error(`Failed to stop daemon: ${result.stderr.trim()}`);
          }
        }

        // Get status after stopping
        const statusResult = await launchctl(["print", serviceTarget]);
        const parsed = parseStatus(statusResult.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "stopped",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: context.globalArgs.plistPath || findPlist(label),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description: "Refresh stored daemon state from launchctl",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { label, domain } = context.globalArgs;
        const uid = await getUid();
        const target = domainTarget(domain, uid);
        const serviceTarget = `${target}/${label}`;

        const result = await launchctl(["print", serviceTarget]);

        if (!result.success) {
          const handle = await context.writeResource("daemon", "main", {
            label,
            status: "not_found",
            pid: null,
            exitCode: null,
            plistPath: context.globalArgs.plistPath || findPlist(label),
            domain,
            syncedAt: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        const parsed = parseStatus(result.stdout);

        const handle = await context.writeResource("daemon", "main", {
          label,
          status: parsed.status || "unknown",
          pid: parsed.pid,
          exitCode: parsed.exitCode,
          plistPath: context.globalArgs.plistPath || findPlist(label),
          domain,
          syncedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "List daemons in the domain. Use 'status' to filter by running/not running, and 'pattern' to filter by label substring.",
      arguments: z.object({
        pattern: z.string().default("").describe("Filter pattern to match against labels"),
        status: z.enum(["all", "running", "not running"]).default("all").describe("Filter by daemon status"),
      }),
      execute: async (args, context) => {
        const { domain } = context.globalArgs;
        const uid = await getUid();
        const target = domainTarget(domain, uid);

        const result = await launchctl(["print", target]);

        if (!result.success) {
          throw new Error(`Failed to list daemons: ${result.stderr.trim()}`);
        }

        const allItems: Array<{ label: string; pid: number | null; exitCode: number | null; status: string }> = [];
        let inServices = false;

        for (const line of result.stdout.split("\n")) {
          const trimmed = line.trim();

          if (trimmed === "services = {") {
            inServices = true;
            continue;
          }
          if (inServices && trimmed === "}") {
            inServices = false;
            continue;
          }

          if (inServices && trimmed.length > 0) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 3) {
              const pidStr = parts[0];
              const exitCodeStr = parts[1];
              const label = parts.slice(2).join(" ");

              if (args.pattern && !label.includes(args.pattern)) continue;

              const pid = pidStr === "-" ? null : parseInt(pidStr, 10);
              const exitCode = exitCodeStr === "-" ? null : parseInt(exitCodeStr, 10);
              const isRunning = pid !== null && !isNaN(pid) && pid > 0;

              allItems.push({
                label,
                pid: isNaN(pid as number) ? null : pid,
                exitCode: isNaN(exitCode as number) ? null : exitCode,
                status: isRunning ? "running" : "not running",
              });
            }
          }
        }

        const items = args.status === "all"
          ? allItems
          : allItems.filter((i) => i.status === args.status);

        items.sort((a, b) => a.label.localeCompare(b.label));

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
      description: "Report running daemons grouped by software vendor",
      arguments: z.object({
        status: z.enum(["all", "running", "not running"]).default("running").describe("Filter by daemon status"),
      }),
      execute: async (args, context) => {
        const { domain } = context.globalArgs;
        const uid = await getUid();
        const target = domainTarget(domain, uid);

        const result = await launchctl(["print", target]);

        if (!result.success) {
          throw new Error(`Failed to list daemons: ${result.stderr.trim()}`);
        }

        const grouped: Record<string, string[]> = {};
        let inServices = false;

        for (const line of result.stdout.split("\n")) {
          const trimmed = line.trim();

          if (trimmed === "services = {") {
            inServices = true;
            continue;
          }
          if (inServices && trimmed === "}") {
            inServices = false;
            continue;
          }

          if (inServices && trimmed.length > 0) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 3) {
              const pidStr = parts[0];
              const label = parts.slice(2).join(" ");

              const pid = pidStr === "-" ? null : parseInt(pidStr, 10);
              const isRunning = pid !== null && !isNaN(pid) && pid > 0;

              if (args.status === "running" && !isRunning) continue;
              if (args.status === "not running" && isRunning) continue;

              const vendor = extractVendor(label);
              if (!grouped[vendor]) grouped[vendor] = [];
              grouped[vendor].push(label);
            }
          }
        }

        const vendors = Object.entries(grouped)
          .map(([vendor, labels]) => ({
            vendor,
            daemonCount: labels.length,
            labels: labels.sort(),
          }))
          .sort((a, b) => b.daemonCount - a.daemonCount);

        const totalDaemons = vendors.reduce((sum, v) => sum + v.daemonCount, 0);

        const handle = await context.writeResource("vendors", "main", {
          vendors,
          totalVendors: vendors.length,
          totalDaemons,
          queriedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
