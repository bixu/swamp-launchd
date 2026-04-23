// Vendor extraction from reverse-DNS launchd labels

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
  "io.kandji": "Kandji",
  "org.mozilla": "Mozilla",
  "org.chromium": "Chromium",
  "org.pqrs": "Karabiner-Elements",
  "net.telestream": "Telestream",
  "app.tuple": "Tuple",
  "ai.perplexity": "Perplexity",
  "dev.warp": "Warp",
  "co.teamport": "Teamport",
};

// Sorted by length descending for longest-prefix match
const SORTED_PREFIXES = Object.keys(VENDOR_MAP).sort((a, b) =>
  b.length - a.length
);

/** Extracts a human-readable vendor name from a reverse-DNS launchd label. */
export function extractVendor(label: string): string {
  let cleaned = label;
  if (cleaned.startsWith("application.")) {
    cleaned = cleaned.slice("application.".length);
  }

  for (const prefix of SORTED_PREFIXES) {
    if (cleaned.startsWith(prefix + ".") || cleaned === prefix) {
      return VENDOR_MAP[prefix];
    }
  }

  // Apple App Store team ID prefix for 1Password
  if (cleaned.startsWith("2BUA8C4S2C.com.1password")) return "1Password";

  const parts = cleaned.split(".");
  if (parts.length >= 2) {
    const tld = parts[0];
    const org = parts[1];
    return org.charAt(0).toUpperCase() + org.slice(1) + ` (${tld}.${org})`;
  }

  return cleaned;
}
