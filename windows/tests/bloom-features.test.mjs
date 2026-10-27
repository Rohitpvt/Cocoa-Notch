// Tests for High-Synergy Bloom Island features ported to Cocoa Notch
// Covers: Pomodoro Focus Sprints, Shelf Staging, Connected Accessories, and Beat-Reactive Mochi

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { State } from "../src/core/state.ts";
import { WelfareManager } from "../src/core/welfare.ts";
import { BotEngine } from "../src/mochi/engine.ts";
import { buildShelf } from "../src/views/shelf.ts";

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

  // Add Bluetooth headphone
  State.addOrUpdateAccessory({
    id: "sony-wh1000",
    name: "WH-1000XM5",
    batteryLevel: 80,
    type: "headphones",
    isConnected: true,
  });
  assert.equal(State.accessoryDevices.length, 1);
  assert.equal(State.accessoryDevices[0].batteryLevel, 80);

  // Update battery level to 15% (low battery)
  State.addOrUpdateAccessory({
    id: "sony-wh1000",
    name: "WH-1000XM5",
    batteryLevel: 15,
    type: "headphones",
    isConnected: true,
  });
  assert.equal(State.accessoryDevices.length, 1);
  assert.equal(State.accessoryDevices[0].batteryLevel, 15);
  assert.equal(State.accessoryDevices[0].type, "headphones");
  assert.equal(State.accessoryDevices[0].isConnected, true);
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
