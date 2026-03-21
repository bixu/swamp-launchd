// Plist parsing and generation helpers

import { getPlistSearchDirs, runCmd } from "./launchctl.ts";

export interface PlistInfo {
  label: string;
  path: string;
  program: string | null;
  programArguments: string[];
  runAtLoad: boolean;
  keepAlive: boolean | Record<string, unknown> | null;
  startInterval: number | null;
  startCalendarInterval: Record<string, number>[] | null;
  watchPaths: string[];
  environmentVariables: Record<string, string>;
  workingDirectory: string | null;
  standardOutPath: string | null;
  standardErrorPath: string | null;
  userName: string | null;
  groupName: string | null;
  disabled: boolean;
  rawKeys: string[];
}

export async function readPlist(
  path: string,
): Promise<Record<string, unknown>> {
  // Convert binary plist to JSON using plutil
  const result = await runCmd("plutil", ["-convert", "json", "-o", "-", path]);
  if (!result.success) {
    throw new Error(`Failed to read plist at ${path}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

export async function validatePlist(
  path: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const result = await runCmd("plutil", ["-lint", path]);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.stderr.split("\n").filter((l) => l.trim().length > 0),
  };
}

export function parsePlistData(
  data: Record<string, unknown>,
  path: string,
): PlistInfo {
  const calInterval = data.StartCalendarInterval;
  let startCalendarInterval: Record<string, number>[] | null = null;
  if (Array.isArray(calInterval)) {
    startCalendarInterval = calInterval as Record<string, number>[];
  } else if (calInterval && typeof calInterval === "object") {
    startCalendarInterval = [calInterval as Record<string, number>];
  }

  return {
    label: (data.Label as string) ?? "",
    path,
    program: (data.Program as string) ?? null,
    programArguments: (data.ProgramArguments as string[]) ?? [],
    runAtLoad: (data.RunAtLoad as boolean) ?? false,
    keepAlive: data.KeepAlive !== undefined
      ? (data.KeepAlive as boolean | Record<string, unknown>)
      : null,
    startInterval: (data.StartInterval as number) ?? null,
    startCalendarInterval,
    watchPaths: (data.WatchPaths as string[]) ?? [],
    environmentVariables:
      (data.EnvironmentVariables as Record<string, string>) ?? {},
    workingDirectory: (data.WorkingDirectory as string) ?? null,
    standardOutPath: (data.StandardOutPath as string) ?? null,
    standardErrorPath: (data.StandardErrorPath as string) ?? null,
    userName: (data.UserName as string) ?? null,
    groupName: (data.GroupName as string) ?? null,
    disabled: (data.Disabled as boolean) ?? false,
    rawKeys: Object.keys(data),
  };
}

export async function getPlistInfo(path: string): Promise<PlistInfo> {
  const data = await readPlist(path);
  return parsePlistData(data, path);
}

export interface PlistCreateOptions {
  label: string;
  program?: string;
  programArguments?: string[];
  runAtLoad?: boolean;
  keepAlive?: boolean;
  startInterval?: number;
  startCalendarInterval?: Record<string, number>;
  watchPaths?: string[];
  environmentVariables?: Record<string, string>;
  workingDirectory?: string;
  standardOutPath?: string;
  standardErrorPath?: string;
}

export function generatePlistXml(opts: PlistCreateOptions): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${escapeXml(opts.label)}</string>`,
  ];

  if (opts.program) {
    lines.push("\t<key>Program</key>");
    lines.push(`\t<string>${escapeXml(opts.program)}</string>`);
  }

  if (opts.programArguments && opts.programArguments.length > 0) {
    lines.push("\t<key>ProgramArguments</key>");
    lines.push("\t<array>");
    for (const arg of opts.programArguments) {
      lines.push(`\t\t<string>${escapeXml(arg)}</string>`);
    }
    lines.push("\t</array>");
  }

  if (opts.runAtLoad !== undefined) {
    lines.push("\t<key>RunAtLoad</key>");
    lines.push(`\t<${opts.runAtLoad}/>`);
  }

  if (opts.keepAlive !== undefined) {
    lines.push("\t<key>KeepAlive</key>");
    lines.push(`\t<${opts.keepAlive}/>`);
  }

  if (opts.startInterval) {
    lines.push("\t<key>StartInterval</key>");
    lines.push(`\t<integer>${opts.startInterval}</integer>`);
  }

  if (opts.startCalendarInterval) {
    lines.push("\t<key>StartCalendarInterval</key>");
    lines.push("\t<dict>");
    for (const [key, val] of Object.entries(opts.startCalendarInterval)) {
      lines.push(`\t\t<key>${escapeXml(key)}</key>`);
      lines.push(`\t\t<integer>${val}</integer>`);
    }
    lines.push("\t</dict>");
  }

  if (opts.watchPaths && opts.watchPaths.length > 0) {
    lines.push("\t<key>WatchPaths</key>");
    lines.push("\t<array>");
    for (const p of opts.watchPaths) {
      lines.push(`\t\t<string>${escapeXml(p)}</string>`);
    }
    lines.push("\t</array>");
  }

  if (
    opts.environmentVariables &&
    Object.keys(opts.environmentVariables).length > 0
  ) {
    lines.push("\t<key>EnvironmentVariables</key>");
    lines.push("\t<dict>");
    for (const [key, val] of Object.entries(opts.environmentVariables)) {
      lines.push(`\t\t<key>${escapeXml(key)}</key>`);
      lines.push(`\t\t<string>${escapeXml(val)}</string>`);
    }
    lines.push("\t</dict>");
  }

  if (opts.workingDirectory) {
    lines.push("\t<key>WorkingDirectory</key>");
    lines.push(`\t<string>${escapeXml(opts.workingDirectory)}</string>`);
  }

  if (opts.standardOutPath) {
    lines.push("\t<key>StandardOutPath</key>");
    lines.push(`\t<string>${escapeXml(opts.standardOutPath)}</string>`);
  }

  if (opts.standardErrorPath) {
    lines.push("\t<key>StandardErrorPath</key>");
    lines.push(`\t<string>${escapeXml(opts.standardErrorPath)}</string>`);
  }

  lines.push("</dict>");
  lines.push("</plist>");
  lines.push("");

  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DiscoveredPlist {
  label: string;
  path: string;
  directory: string;
  type: "agent" | "daemon";
}

export async function scanPlistDirectories(
  pattern?: string,
): Promise<DiscoveredPlist[]> {
  const results: DiscoveredPlist[] = [];

  for (const dir of getPlistSearchDirs()) {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch {
      continue; // directory doesn't exist or no permission
    }

    const isDaemon = dir.includes("LaunchDaemons");

    for (const entry of entries) {
      if (!entry.name.endsWith(".plist")) continue;
      const label = entry.name.replace(/\.plist$/, "");
      if (pattern && !label.includes(pattern)) continue;

      results.push({
        label,
        path: `${dir}/${entry.name}`,
        directory: dir,
        type: isDaemon ? "daemon" : "agent",
      });
    }
  }

  results.sort((a, b) => a.label.localeCompare(b.label));
  return results;
}
