import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge } from "../src/core/bridge.ts";
import { calls, sent } from "./tauri.mjs";

test("lib.rs BROWSER_ARGS matches tauri.conf.json island additionalBrowserArgs", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const islandArgs = conf.app?.windows?.[0]?.additionalBrowserArgs;
  assert.ok(typeof islandArgs === "string" && islandArgs.length > 0, "island additionalBrowserArgs must be set");

  const libRs = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const match = libRs.match(/pub\(crate\)\s+const\s+BROWSER_ARGS:\s*&str\s*=\s*"([^"]+)"/);
  assert.ok(match, "BROWSER_ARGS constant must be declared in lib.rs");
  assert.equal(
    match[1],
    islandArgs,
    "WebView2 requires identical additionalBrowserArgs across island and settings windows",
  );
});

test("Bridge.openSettingsWindow invokes open_settings_window command", async () => {
  calls.length = 0;
  await Bridge.openSettingsWindow();
  assert.deepEqual(sent("open_settings_window"), [{}]);
});
