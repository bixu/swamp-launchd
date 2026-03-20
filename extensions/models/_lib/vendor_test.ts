import { assertEquals } from "@std/assert";
import { extractVendor } from "./vendor.ts";

// ── Known vendors ───────────────────────────────────────────────────────────

Deno.test("extractVendor identifies Apple", () => {
  assertEquals(extractVendor("com.apple.Finder"), "Apple");
  assertEquals(extractVendor("com.apple.Dock.agent"), "Apple");
});

Deno.test("extractVendor identifies Google", () => {
  assertEquals(extractVendor("com.google.Chrome"), "Google");
});

Deno.test("extractVendor identifies Docker", () => {
  assertEquals(extractVendor("com.docker.docker"), "Docker");
});

Deno.test("extractVendor identifies Tailscale", () => {
  assertEquals(extractVendor("io.tailscale.ipn.macsys"), "Tailscale");
});

Deno.test("extractVendor identifies Kandji", () => {
  assertEquals(extractVendor("io.kandji.Kandji"), "Kandji");
});

Deno.test("extractVendor identifies Mozilla", () => {
  assertEquals(extractVendor("org.mozilla.firefox"), "Mozilla");
});

Deno.test("extractVendor identifies Tuple", () => {
  assertEquals(extractVendor("app.tuple.app"), "Tuple");
});

Deno.test("extractVendor identifies Perplexity", () => {
  assertEquals(extractVendor("ai.perplexity.mac"), "Perplexity");
});

// ── Application prefix stripping ────────────────────────────────────────────

Deno.test("extractVendor strips application. prefix", () => {
  assertEquals(
    extractVendor("application.com.apple.Safari.12345.67890"),
    "Apple",
  );
  assertEquals(
    extractVendor("application.com.docker.docker.123.456"),
    "Docker",
  );
  assertEquals(
    extractVendor("application.io.tailscale.ipn.macsys.123.456"),
    "Tailscale",
  );
});

// ── 1Password special case ──────────────────────────────────────────────────

Deno.test("extractVendor identifies 1Password via team ID prefix", () => {
  assertEquals(
    extractVendor("2BUA8C4S2C.com.1password.browser-helper"),
    "1Password",
  );
});

Deno.test("extractVendor identifies 1Password via com.1password", () => {
  assertEquals(extractVendor("com.1password.something"), "1Password");
});

Deno.test("extractVendor identifies 1Password via AgileBits", () => {
  assertEquals(
    extractVendor("com.agilebits.something"),
    "1Password (AgileBits)",
  );
});

// ── Longest prefix match ────────────────────────────────────────────────────

Deno.test("extractVendor uses longest prefix match for Logitech variants", () => {
  assertEquals(extractVendor("com.logi.something"), "Logitech");
  assertEquals(extractVendor("com.logitech.something"), "Logitech");
});

// ── Unknown vendors ─────────────────────────────────────────────────────────

Deno.test("extractVendor falls back to capitalized org for unknown vendors", () => {
  assertEquals(
    extractVendor("com.acmecorp.myapp"),
    "Acmecorp (com.acmecorp)",
  );
  assertEquals(
    extractVendor("io.mycompany.service"),
    "Mycompany (io.mycompany)",
  );
});

Deno.test("extractVendor returns label as-is for single-segment labels", () => {
  assertEquals(extractVendor("standalone"), "standalone");
});

// ── Edge cases ──────────────────────────────────────────────────────────────

Deno.test("extractVendor handles label equal to vendor prefix", () => {
  assertEquals(extractVendor("com.apple"), "Apple");
});

Deno.test("extractVendor handles application. prefix with unknown vendor", () => {
  assertEquals(
    extractVendor("application.com.unknown.app.123.456"),
    "Unknown (com.unknown)",
  );
});

Deno.test("extractVendor handles leits.MeetingBar style labels", () => {
  assertEquals(
    extractVendor("application.leits.MeetingBar.123.456"),
    "MeetingBar (leits.MeetingBar)",
  );
});
