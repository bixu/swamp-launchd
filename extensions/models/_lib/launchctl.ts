// Shared launchctl helpers

const decoder = new TextDecoder();

/** Returns the current user's numeric UID as a string. */
export async function getUid(): Promise<string> {
  const cmd = new Deno.Command("id", {
    args: ["-u"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return decoder.decode(output.stdout).trim();
}

/** Converts a domain name and UID into a launchd domain target string. */
export function domainTarget(domain: string, uid: string): string {
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

/** Result of running a shell command. */
export interface CmdResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

/** Runs a launchctl subcommand and returns the result. */
export async function launchctl(args: string[]): Promise<CmdResult> {
  const cmd = new Deno.Command("launchctl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    success: output.success,
    code: output.code,
  };
}

/** Runs an arbitrary shell command and returns the result. */
export async function runCmd(
  command: string,
  args: string[],
): Promise<CmdResult> {
  const cmd = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    success: output.success,
    code: output.code,
  };
}

/** Parses PID, exit code, and state from `launchctl print` output. */
export function parseServiceStatus(stdout: string): {
  pid: number | null;
  exitCode: number | null;
  status: string;
} {
  let pid: number | null = null;
  let exitCode: number | null = null;
  let status = "unknown";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("pid =")) {
      const val = trimmed.split("=")[1]?.trim();
      if (val && val !== "(null)") pid = parseInt(val, 10);
    }
    if (
      trimmed.startsWith("last exit code =") ||
      trimmed.startsWith("exit code =")
    ) {
      const val = trimmed.split("=")[1]?.trim();
      if (val && val !== "(null)") exitCode = parseInt(val, 10);
    }
    if (trimmed.startsWith("state =")) {
      status = trimmed.split("=")[1]?.trim() ?? "unknown";
    }
  }

  return { pid, exitCode, status };
}

/** Detailed information about a launchd service parsed from `launchctl print`. */
export interface DetailedServiceInfo {
  pid: number | null;
  exitCode: number | null;
  status: string;
  program: string | null;
  programArguments: string[];
  environmentVariables: Record<string, string>;
  machServices: string[];
  enabledState: string | null;
  timeout: number | null;
  onDemand: boolean | null;
  keepAlive: boolean | null;
  runsInBackground: boolean | null;
}

/** Parses detailed service info (program, env, mach services, etc.) from `launchctl print` output. */
export function parseServiceDetail(stdout: string): DetailedServiceInfo {
  const basic = parseServiceStatus(stdout);
  let program: string | null = null;
  const programArguments: string[] = [];
  const environmentVariables: Record<string, string> = {};
  const machServices: string[] = [];
  let enabledState: string | null = null;
  let timeout: number | null = null;
  let onDemand: boolean | null = null;
  let keepAlive: boolean | null = null;
  let runsInBackground: boolean | null = null;

  let inProgramArgs = false;
  let inEnvironment = false;
  let inMachServices = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    // Program path
    if (trimmed.startsWith("program =")) {
      program = trimmed.split("=")[1]?.trim() ?? null;
    }

    // Program arguments section
    if (trimmed === "arguments = {") {
      inProgramArgs = true;
      continue;
    }
    if (inProgramArgs) {
      if (trimmed === "}") {
        inProgramArgs = false;
        continue;
      }
      programArguments.push(trimmed);
    }

    // Environment section
    if (trimmed === "environment = {") {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment) {
      if (trimmed === "}") {
        inEnvironment = false;
        continue;
      }
      const eqIdx = trimmed.indexOf("=>");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 2).trim();
        environmentVariables[key] = val;
      }
    }

    // Mach services
    if (trimmed === "machservices = {" || trimmed === "endpoints = {") {
      inMachServices = true;
      continue;
    }
    if (inMachServices) {
      if (trimmed === "}") {
        inMachServices = false;
        continue;
      }
      const name = trimmed.split("=")[0]?.trim();
      if (name) machServices.push(name);
    }

    // Enabled state
    if (trimmed.startsWith("enabled =")) {
      enabledState = trimmed.split("=")[1]?.trim() ?? null;
    }

    // Timeout
    if (trimmed.startsWith("timeout =")) {
      const val = trimmed.split("=")[1]?.trim();
      if (val) timeout = parseInt(val, 10);
    }

    // On demand
    if (trimmed.startsWith("on-demand =")) {
      onDemand = trimmed.includes("true");
    }

    // Keep alive
    if (
      trimmed.startsWith("keep alive =") || trimmed.startsWith("keepalive =")
    ) {
      keepAlive = trimmed.includes("true") || trimmed.includes("1");
    }

    // Runs in background
    if (trimmed.startsWith("runs in background =")) {
      runsInBackground = trimmed.includes("true");
    }
  }

  return {
    ...basic,
    program,
    programArguments,
    environmentVariables,
    machServices,
    enabledState,
    timeout,
    onDemand,
    keepAlive,
    runsInBackground,
  };
}

/** A single service entry from the launchd domain service list. */
export interface ServiceListItem {
  label: string;
  pid: number | null;
  exitCode: number | null;
  status: string;
}

/** Parses the services block from `launchctl print` output, with optional pattern and status filtering. */
export function parseServiceList(
  stdout: string,
  pattern?: string,
  statusFilter?: string,
): ServiceListItem[] {
  const items: ServiceListItem[] = [];
  let inServices = false;

  for (const line of stdout.split("\n")) {
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

        if (pattern && !label.includes(pattern)) continue;

        const pid = pidStr === "-" ? null : parseInt(pidStr, 10);
        const exitCode = exitCodeStr === "-" ? null : parseInt(exitCodeStr, 10);
        const isRunning = pid !== null && !isNaN(pid) && pid > 0;
        const status = isRunning ? "running" : "not running";

        if (statusFilter && statusFilter !== "all" && status !== statusFilter) {
          continue;
        }

        items.push({
          label,
          pid: isNaN(pid as number) ? null : pid,
          exitCode: isNaN(exitCode as number) ? null : exitCode,
          status,
        });
      }
    }
  }

  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

/** Returns the standard macOS directories where plist files are located. */
export function getPlistSearchDirs(): string[] {
  return [
    `${Deno.env.get("HOME")}/Library/LaunchAgents`,
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
    "/System/Library/LaunchAgents",
    "/System/Library/LaunchDaemons",
  ];
}

/** Searches standard launchd directories for a plist file matching the given label. */
export function findPlist(label: string): string | null {
  const fileName = `${label}.plist`;
  for (const dir of getPlistSearchDirs()) {
    const path = `${dir}/${fileName}`;
    try {
      Deno.statSync(path);
      return path;
    } catch {
      // not found
    }
  }
  return null;
}

/** Resolves a plist path, making relative paths absolute using the repo directory. */
export function resolvePlistPath(plistPath: string, repoDir: string): string {
  if (plistPath.startsWith("/")) return plistPath;
  return `${repoDir}/${plistPath}`;
}

/** Map of well-known exit codes to human-readable explanations. */
export const EXIT_CODE_MAP: Record<number, string> = {
  0: "Success",
  1: "General error",
  2: "Misuse of shell command",
  78: "Configuration error (EX_CONFIG)",
  126: "Command invoked cannot execute",
  127: "Command not found",
  128: "Invalid exit argument",
  // Signal-based codes (128 + signal number)
  129: "Killed by SIGHUP (1)",
  130: "Killed by SIGINT (2)",
  131: "Killed by SIGQUIT (3)",
  132: "Killed by SIGILL (4)",
  133: "Killed by SIGTRAP (5)",
  134: "Killed by SIGABRT (6)",
  135: "Killed by SIGBUS (7)",
  136: "Killed by SIGFPE (8)",
  137: "Killed by SIGKILL (9)",
  139: "Killed by SIGSEGV (11) — segmentation fault",
  141: "Killed by SIGPIPE (13)",
  143: "Killed by SIGTERM (15) — normal termination",
  // macOS-specific
  172: "Killed by SIGXCPU (24) — CPU time limit exceeded",
  255: "Exit status out of range",
};

/** Returns a human-readable explanation for a process exit code. */
export function explainExitCode(code: number | null): string {
  if (code === null) return "No exit code recorded";
  return EXIT_CODE_MAP[code] ??
    (code > 128
      ? `Killed by signal ${code - 128}`
      : `Unknown exit code ${code}`);
}
