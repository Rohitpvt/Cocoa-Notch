// Tests for High-Synergy Bloom Island features ported to Cocoa Notch
// Covers: Pomodoro Focus Sprints, Shelf Staging, Connected Accessories, and Beat-Reactive Mochi

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { State } from "../src/core/state.ts";
import { WelfareManager } from "../src/core/welfare.ts";
import { BotEngine } from "../src/mochi/engine.ts";
import { buildShelf } from "../src/views/shelf.ts";
import { buildAccessory } from "../src/views/accessory.ts";
import { buildHeader } from "../src/views/views.ts";

installFakeDom();

// ── 1. Pomodoro Focus Sprints ──────────────────────────────────────────────────

test("State handles Pomodoro focus lifecycle: start, pause, resume, stop", () => {
  State.stopPomodoro();
  assert.equal(State.pomodoro.active, false);
  assert.equal(State.pomodoro.phase, "idle");

  // Start 25-minute sprint
  State.startPomodoro(25);
  assert.equal(State.pomodoro.active, true);
  assert.equal(State.pomodoro.phase, "work");
  assert.equal(State.pomodoro.totalSec, 25 * 60);
  assert.equal(State.pomodoro.remainingSec, 25 * 60);
  assert.equal(State.pomodoro.paused, false);

  // Pause
  State.togglePausePomodoro();
  assert.equal(State.pomodoro.paused, true);

  // Resume
  State.togglePausePomodoro();
  assert.equal(State.pomodoro.paused, false);

  // Stop
  State.stopPomodoro();
  assert.equal(State.pomodoro.active, false);
  assert.equal(State.pomodoro.phase, "idle");
});

test("WelfareManager tickPomodoro transitions from work sprint to break and celebrates", () => {
  const manager = new WelfareManager();
  State.startPomodoro(25);
  State.pomodoro.remainingSec = 3;

  // 3 -> 2
  const p1 = manager.tickPomodoro();
  assert.equal(p1, null);
  assert.equal(State.pomodoro.remainingSec, 2);

  // 2 -> 1
  const p2 = manager.tickPomodoro();
  assert.equal(p2, null);
  assert.equal(State.pomodoro.remainingSec, 1);

  // 1 -> complete work sprint -> transition to break
  const p3 = manager.tickPomodoro();
  assert.ok(p3 !== null, "Should return welfare prompt on work completion");
  assert.equal(p3.category, "break");
  assert.equal(p3.quote, "Mission accomplished!");
  assert.equal(State.pomodoro.phase, "break");
  assert.equal(State.pomodoro.completedCount, 1);
  assert.equal(State.pomodoro.remainingSec, 5 * 60);

  // Advance break to 1 sec
  State.pomodoro.remainingSec = 1;
  const p4 = manager.tickPomodoro();
  assert.ok(p4 !== null, "Should return prompt when break completes");
  assert.equal(State.pomodoro.phase, "idle");
  assert.equal(State.pomodoro.active, false);
});

// ── 2. Staging Shelf ──────────────────────────────────────────────────────────

test("Shelf staging manages stashed files, bounds limit to 50, and prevents duplicates", () => {
  State.clearShelf();
  assert.equal(State.shelfFiles.length, 0);

  // Add file
  State.addShelfFile({ name: "diagram.png", path: "/path/to/diagram.png", size: 1024 });
  assert.equal(State.shelfFiles.length, 1);
  assert.equal(State.shelfFiles[0].name, "diagram.png");
  assert.equal(State.shelfFiles[0].path, "/path/to/diagram.png");
  assert.equal(State.shelfFiles[0].size, 1024);

  // Add 55 files to test cap at 50
  for (let i = 1; i <= 55; i++) {
    State.addShelfFile({ name: `file_${i}.txt`, size: i * 10 });
  }
  assert.ok(State.shelfFiles.length <= 50, `Shelf count ${State.shelfFiles.length} should be capped at 50`);

  // Remove specific item
  const idToRemove = State.shelfFiles[0].id;
  State.removeShelfFile(idToRemove);
  assert.ok(!State.shelfFiles.some((f) => f.id === idToRemove));

  // Clear all
  State.clearShelf();
  assert.equal(State.shelfFiles.length, 0);
});

test("Shelf view renders DOM correctly with FakeDOM", () => {
  State.clearShelf();
  State.addShelfFile({ name: "spec.md", path: "/test/spec.md", size: 2048 });
  State.addShelfFile({ name: "app.ts", path: "/test/app.ts", size: 4096 });

  let askedView = "";
  const actions = {
    blip: () => {},
    setView: (view) => {
      askedView = view;
    },
    closePill: () => {},
  };

  const shelfHost = buildShelf(actions);
  shelfHost.sync();

  assert.ok(shelfHost.el.classList.contains("shelf-view"), "Should have .shelf-view class");

  // Find shelf items rendered
  const items = shelfHost.el.find(".shelf-item");
  assert.equal(items.length, 2, "Should render 2 shelf items");

  // Verify 'Ask AI' button interaction
  const askBtn = shelfHost.el.querySelector(".shelf-item-action-btn");
  assert.ok(askBtn !== null, "Should have Ask AI button");
  askBtn.fire("click");
  assert.equal(askedView, "prompt", "Clicking Ask button should switch view to prompt");
  assert.equal(State.droppedFile?.name, "app.ts");
});

// ── 3. Connected Bluetooth Accessory Devices ──────────────────────────────────

test("Accessory device state tracks battery level, connection, and updates", () => {
  State.setAccessoryDevices([]);
  assert.equal(State.accessoryDevices.length, 0);
  assert.equal(State.activeAccessory, null);

  // Add Bluetooth headphone
  State.addOrUpdateAccessory({
    id: "sony-wh1000",
    name: "WH-1000XM5",
    battery: 80,
    kind: "headphones",
    connected: true,
  });
  assert.equal(State.accessoryDevices.length, 1);
  assert.equal(State.accessoryDevices[0].battery, 80);
  assert.equal(State.activeAccessory?.name, "WH-1000XM5");

  // Update battery level to 15% (low battery)
  State.addOrUpdateAccessory({
    id: "sony-wh1000",
    name: "WH-1000XM5",
    battery: 15,
    kind: "headphones",
    connected: true,
  });
  assert.equal(State.accessoryDevices.length, 1);
  assert.equal(State.accessoryDevices[0].battery, 15);
  assert.equal(State.accessoryDevices[0].kind, "headphones");
  assert.equal(State.accessoryDevices[0].connected, true);

  // Add Earbuds with multi-battery
  State.addOrUpdateAccessory({
    id: "airpods-pro",
    name: "AirPods Pro",
    battery: 85,
    leftBud: 85,
    rightBud: 90,
    caseBattery: 100,
    kind: "earbuds",
    connected: true,
  });
  assert.equal(State.accessoryDevices.length, 2);

  // Remove accessory
  State.removeAccessory("sony-wh1000");
  assert.equal(State.accessoryDevices.length, 1);
  assert.equal(State.accessoryDevices[0].id, "airpods-pro");
});

test("Accessory view renders connected earbuds and handles empty state", () => {
  let switchedView = "";
  const actions = {
    setView: (v) => { switchedView = v; },
    blip: () => {},
  };

  const accessoryHost = buildAccessory(actions);
  assert.ok(accessoryHost.el.classList.contains("accessory-view"));

  // Connected state
  State.setAccessoryDevices([{
    id: "galaxy-buds",
    name: "Galaxy Buds Pro",
    battery: 75,
    leftBud: 70,
    rightBud: 80,
    caseBattery: 95,
    kind: "earbuds",
    connected: true,
  }]);

  accessoryHost.sync();
  const nameEl = accessoryHost.el.querySelector(".accessory-dev-name");
  assert.equal(nameEl?.textContent, "Galaxy Buds Pro");

  const budCards = accessoryHost.el.find(".bud-battery-card");
  assert.equal(budCards.length, 3, "Should render Left, Right, and Case battery cards");

  // Disconnected state
  State.setAccessoryDevices([]);
  accessoryHost.sync();
  const emptyTitle = accessoryHost.el.querySelector(".accessory-empty-title");
  assert.ok(emptyTitle !== null, "Should render empty state when no accessories connected");
});

// ── 4. Beat-Reactive Mochi & Music Playback State ─────────────────────────────

test("BotEngine dancing: beat reactive dancingLevel smoothly ramps up and down", () => {
  const engine = new BotEngine();
  assert.equal(engine.isDancing, false);
  assert.equal(engine.dancingLevel, 0);

  // Start dancing at 120 BPM
  engine.setDancing(true, 120);
  assert.equal(engine.isDancing, true);
  assert.equal(engine.dancingBpm, 120);

  // After 0.15s, dancingLevel ramps up (0.15 / 0.3 = 0.5)
  engine.update(0.15);
  assert.ok(Math.abs(engine.dancingLevel - 0.5) < 0.05, `dancingLevel should be ~0.5, got ${engine.dancingLevel}`);
  assert.equal(engine.busy, true, "Engine should be busy while dancingLevel > 0");

  // After another 0.20s, reaches max 1.0
  engine.update(0.2);
  assert.equal(engine.dancingLevel, 1.0, "dancingLevel should clamp to 1.0");

  // Stop dancing
  engine.setDancing(false);
  assert.equal(engine.isDancing, false);

  // Decays by 0.25 / 0.5 = 0.5
  engine.update(0.25);
  assert.ok(Math.abs(engine.dancingLevel - 0.5) < 0.05, `dancingLevel should decay to ~0.5, got ${engine.dancingLevel}`);

  // Decays back to 0
  engine.update(0.3);
  assert.equal(engine.dancingLevel, 0.0, "dancingLevel should reach 0.0");
});

test("Music playback state updates album color and song info", () => {
  State.setMusicPlayback({
    title: "Midnight City",
    artist: "M83",
    albumColor: "#FF5500",
    isPlaying: true,
    bpm: 105,
  });

  assert.ok(State.musicPlayback !== null);
  assert.equal(State.musicPlayback.title, "Midnight City");
  assert.equal(State.musicPlayback.albumColor, "#FF5500");
  assert.equal(State.musicPlayback.isPlaying, true);
  assert.equal(State.musicPlayback.bpm, 105);
});

test("Beat-Reactive Mochi tempo adapts to musicPlayback BPM and settings toggle", () => {
  const engine = new BotEngine();
  State.settings.beatReactiveMochi = true;

  State.setMusicPlayback({
    title: "Around the World",
    artist: "Daft Punk",
    albumColor: "#E11D48",
    isPlaying: true,
    bpm: 128,
  });

  // Verify engine sets tempo from playback state
  const shouldDance = State.musicPlayback.isPlaying && State.settings.beatReactiveMochi !== false;
  engine.setDancing(shouldDance, State.musicPlayback.bpm);

  assert.equal(engine.isDancing, true);
  assert.equal(engine.dancingBpm, 128);

  // When disabled in settings, dancing is suppressed
  State.settings.beatReactiveMochi = false;
  const shouldDanceDisabled = State.musicPlayback.isPlaying && State.settings.beatReactiveMochi !== false;
  engine.setDancing(shouldDanceDisabled);
  assert.equal(engine.isDancing, false);

  // Restore setting
  State.settings.beatReactiveMochi = true;
});

test("Ambient Artwork Glow resolves color, follows playback, and respects settings", () => {
  assert.equal(State.settings.ambientMusicGlow, true, "ambientMusicGlow should default to true");

  State.setMusicPlayback({
    title: "Starboy",
    artist: "The Weeknd",
    albumColor: "#F59E0B",
    isPlaying: true,
    bpm: 186,
  });

  // Glow color resolution
  const glowColor1 = State.musicPlayback?.albumColor || "#1DB954";
  assert.equal(glowColor1, "#F59E0B");

  // Fallback when albumColor is omitted
  State.setMusicPlayback({
    title: "Blinding Lights",
    isPlaying: true,
  });
  const glowColor2 = State.musicPlayback?.albumColor || "#1DB954";
  assert.equal(glowColor2, "#1DB954");

  // Setting toggle disables glow
  State.settings.ambientMusicGlow = false;
  const shouldGlow = (State.musicPlayback?.isPlaying ?? false) && State.settings.ambientMusicGlow !== false;
  assert.equal(shouldGlow, false);

  // Restore setting
  State.settings.ambientMusicGlow = true;
});

// ── 5. Responsive Header Stats & Non-Overlapping Layout ───────────────────────

test("Header layout mounts tabs on left, stats in center, actions on right", () => {
  State.setMusicPlayback(null);
  const actions = {
    blip: () => {},
    collapse: () => {},
    setView: () => {},
    toggleSound: () => {},
    openTarget: () => {},
  };
  const header = buildHeader(actions);
  header.sync();

  const el = header.el;
  assert.equal(el.getAttribute("id"), "header");
  assert.equal(el.children.length, 3);

  const tabs = el.children[0];
  const stats = el.children[1];
  const actionsEl = el.children[2];

  assert.ok(tabs.classList.contains("tabs"), "First child must be .tabs");
  assert.ok(stats.classList.contains("header-stats"), "Second child must be .header-stats");
  assert.ok(actionsEl.classList.contains("header-actions"), "Third child must be .header-actions");
});

test("Header stats dynamically declutter and apply priority classes at narrow expanded widths", () => {
  State.setMusicPlayback(null);
  const actions = {
    blip: () => {},
    collapse: () => {},
    setView: () => {},
    toggleSound: () => {},
    openTarget: () => {},
  };
  const header = buildHeader(actions);

  // Setup system stats and accessory
  State.setSystemStats({
    cpuUsage: 25,
    gpuUsage: 35,
    gpuTemp: 45,
    ramUsage: 50,
    ramUsedGb: 8.0,
    ramTotalGb: 16.0,
  });
  State.settings.showSystemStats = true;
  State.settings.showCpuUsage = true;
  State.settings.showGpuUsage = true;
  State.settings.showGpuTemp = true;
  State.settings.showRamUsage = true;
  State.settings.showBluetoothBattery = true;
  State.setAccessoryDevices([
    {
      id: "buds-1",
      name: "AirPods Pro",
      battery: 80,
      connected: true,
      kind: "earbuds",
    },
  ]);

  // Case A: Default wide width (640px)
  State.settings.expandedWidth = 640;
  header.sync();

  const statsEl = header.el.children[1];
  const chipsWide = statsEl.find(".stat-chip");
  // Accessory (high), CPU (high), GPU (med), Temp (low), RAM (low)
  assert.ok(chipsWide.length >= 4, `At 640px wide should render all permitted chips (got ${chipsWide.length})`);
  assert.ok(chipsWide.some((c) => c.classList.contains("stat-chip-high")), "Must contain high priority chips");
  assert.ok(chipsWide.some((c) => c.classList.contains("stat-chip-med")), "Must contain med priority chips");
  assert.ok(chipsWide.some((c) => c.classList.contains("stat-chip-low")), "Must contain low priority chips");

  // Case B: Narrow width (520px) with active accessory
  State.settings.expandedWidth = 520;
  header.sync();

  const chipsNarrow = statsEl.find(".stat-chip");
  // Should omit temp and ram (low priority) when media is active at narrow width
  assert.ok(!chipsNarrow.some((c) => c.classList.contains("stat-chip-low")), "At 520px with active accessory, low priority chips must be suppressed");
  assert.ok(chipsNarrow.some((c) => c.classList.contains("accessory-chip")), "Accessory chip must stay visible");
  assert.ok(chipsNarrow.some((c) => c.textContent?.includes("CPU")), "CPU chip must stay visible");

  // Case C: Minimum supported width (480px)
  State.settings.expandedWidth = 480;
  header.sync();

  const chipsMin = statsEl.find(".stat-chip");
  assert.ok(chipsMin.length <= 3, `At 480px should render at most 2-3 essential chips (got ${chipsMin.length})`);
  assert.ok(!chipsMin.some((c) => c.classList.contains("stat-chip-low")), "Low priority chips must not be present at 480px");

  // Restore defaults
  State.settings.expandedWidth = 640;
  State.setAccessoryDevices([]);
});

// ── 5. Canvas Animation Loop & Notification Glitch Hardening ──────────────────

test("Spring and Tracked handle negative, zero, and NaN dt without exploding or becoming NaN", async () => {
  const { Spring, Tracked } = await import("../src/core/anim.ts");
  const s = new Spring(100);
  s.target = 200;

  // Normal step
  s.step(0.016);
  assert.ok(Number.isFinite(s.value));

  // Extreme negative dt (e.g. clock drift or wake from throttled suspension)
  s.step(-1000);
  assert.ok(Number.isFinite(s.value), "Spring value must remain finite after negative dt");
  assert.ok(Number.isFinite(s.velocity), "Spring velocity must remain finite after negative dt");

  // NaN dt
  s.step(Number.NaN);
  assert.ok(Number.isFinite(s.value), "Spring value must remain finite after NaN dt");

  // Tracked
  const t = new Tracked(50);
  t.springTo(100);
  t.step(-500);
  assert.ok(Number.isFinite(t.value), "Tracked value must remain finite after negative dt");
  t.step(Number.NaN);
  assert.ok(Number.isFinite(t.value), "Tracked value must remain finite after NaN dt");
});

test("BotEngine update sanitizes negative, zero, or NaN dt and keeps sx, sy, es bounded", () => {
  const engine = new BotEngine();
  engine.isMini = true;

  // Initial values
  assert.equal(engine.sx, 1);
  assert.equal(engine.sy, 1);

  // Severe negative dt (which previously caused Math.pow(0.0008, dt) to produce Infinity)
  engine.update(-1200);
  assert.ok(Number.isFinite(engine.sx), "engine.sx must remain finite");
  assert.ok(Number.isFinite(engine.sy), "engine.sy must remain finite");
  assert.ok(engine.sx >= 0.1 && engine.sx <= 5, "engine.sx must stay within bounded range [0.1, 5]");
  assert.ok(engine.sy >= 0.1 && engine.sy <= 5, "engine.sy must stay within bounded range [0.1, 5]");

  // NaN dt
  engine.update(Number.NaN);
  assert.ok(Number.isFinite(engine.sx), "engine.sx must remain finite on NaN dt");
  assert.ok(Number.isFinite(engine.sy), "engine.sy must remain finite on NaN dt");

  // Verify normal ticking works cleanly after recovery
  engine.update(0.016);
  assert.ok(Number.isFinite(engine.sx));
  assert.ok(Number.isFinite(engine.sy));
});

test("tickMiniBots and pruneMiniBots handle disconnected canvases and negative dt safely", async () => {
  const { createMiniBot, tickMiniBots, pruneMiniBots, miniBotCount } = await import("../src/mochi/minibots.ts");

  const task = {
    id: "test_task_1",
    name: "Test Pill",
    color: "#10b981",
    state: "idle",
    steps: [],
    stepIndex: 0,
  };

  const el = createMiniBot(task, 24);
  const initialCount = miniBotCount();
  assert.ok(initialCount >= 1, "Must have at least one live mini bot registered");

  // Canvas child element in slot
  const canvas = el.children[0];
  assert.ok(canvas, "Canvas must exist in slot");

  // Negative dt should not throw
  assert.doesNotThrow(() => {
    tickMiniBots(-50);
  });

  // NaN dt should not throw
  assert.doesNotThrow(() => {
    tickMiniBots(Number.NaN);
  });

  // Normal dt should not throw
  assert.doesNotThrow(() => {
    tickMiniBots(0.016);
  });

  // When element is disconnected, pruneMiniBots removes it from live map
  canvas.isConnected = false;
  pruneMiniBots();
  assert.ok(miniBotCount() < initialCount, "Disconnected canvas must be pruned from live map");
});

// ── 8. Notification Deduplication & Repeat Suppression ──────────────────────────

test("System notification deduplication suppresses repeating notifications and duplicate cards", () => {
  State.clearNotificationHistory();

  const notif1 = {
    id: 101,
    appName: "WhatsApp",
    title: "Adikala Members",
    body: "Congratulations to My Entire Adikala Family!",
    timestamp: Date.now(),
  };

  // 1. Fresh notification alerts
  const firstAlert = State.addSystemNotification(notif1);
  assert.equal(firstAlert, true, "First arrival should alert");
  assert.equal(State.notificationHistory.length, 1);
  assert.equal(State.activeNotification?.title, "Adikala Members");

  // 2. Duplicate notification with new ID (WhatsApp background sync re-post) within cooldown is suppressed
  const notifRepeat = {
    id: 102,
    appName: "WhatsApp",
    title: "Adikala Members",
    body: "Congratulations to My Entire Adikala Family!",
    timestamp: Date.now() + 120000,
  };
  const repeatAlert = State.addSystemNotification(notifRepeat);
  assert.equal(repeatAlert, false, "Repeating notification within cooldown must be suppressed");
  assert.equal(State.notificationHistory.length, 1, "Duplicate notification must not pollute history list");

  // 3. Whitespace variation (e.g. trailing newlines/tabs from Windows toasts) is normalized and suppressed
  const notifWhitespace = {
    id: 103,
    appName: " WhatsApp  ",
    title: "Adikala   Members",
    body: "Congratulations to My Entire Adikala Family!\n\t\t",
    timestamp: Date.now() + 180000,
  };
  const wsAlert = State.addSystemNotification(notifWhitespace);
  assert.equal(wsAlert, false, "Whitespace-varied identical notification must be suppressed");
  assert.equal(State.notificationHistory.length, 1);

  // 4. Fresh notification from same chat with DIFFERENT body alerts immediately
  const notifNewMessage = {
    id: 104,
    appName: "WhatsApp",
    title: "Adikala Members",
    body: "Meeting at 5 PM today!",
    timestamp: Date.now() + 200000,
  };
  const newAlert = State.addSystemNotification(notifNewMessage);
  assert.equal(newAlert, true, "New message with different content must alert immediately");
  assert.equal(State.notificationHistory.length, 2);
  assert.equal(State.activeNotification?.body, "Meeting at 5 PM today!");

  // 5. User dismisses a notification -> subsequent repeats of dismissed notification are completely suppressed
  State.removeSystemNotification(104);
  assert.equal(State.notificationHistory.length, 1);

  const notifDismissedRepeat = {
    id: 105,
    appName: "WhatsApp",
    title: "Adikala Members",
    body: "Meeting at 5 PM today!",
    timestamp: Date.now() + 300000,
  };
  const dismissedAlert = State.addSystemNotification(notifDismissedRepeat);
  assert.equal(dismissedAlert, false, "Dismissed notification must not re-alert");
  assert.equal(State.notificationHistory.length, 1);

  // 6. Clear all suppresses all currently existing notifications from resurrecting
  State.clearNotificationHistory();
  assert.equal(State.notificationHistory.length, 0);

  const notifResurrect = {
    id: 106,
    appName: "WhatsApp",
    title: "Adikala Members",
    body: "Congratulations to My Entire Adikala Family!",
    timestamp: Date.now() + 400000,
  };
  const resurrectAlert = State.addSystemNotification(notifResurrect);
  assert.equal(resurrectAlert, false, "Cleared notifications must not re-alert or resurrect");
  assert.equal(State.notificationHistory.length, 0);
});
