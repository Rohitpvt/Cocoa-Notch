// Tests for Mochi Welfare & Wellness system (src/core/welfare.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { State, DEFAULT_SETTINGS } from "../src/core/state.ts";
import { WelfareManager, WELFARE_QUOTES, welfareManager } from "../src/core/welfare.ts";

test("WELFARE_QUOTES catalog contains valid items across all categories", () => {
  assert.ok(WELFARE_QUOTES.length > 5, "Catalog should have ample quotes");
  const categories = new Set(WELFARE_QUOTES.map((q) => q.category));
  assert.ok(categories.has("break"), "Should have break quotes");
  assert.ok(categories.has("hydrate"), "Should have hydrate quotes");
  assert.ok(categories.has("posture"), "Should have posture quotes");
  assert.ok(categories.has("night"), "Should have night quotes");
  assert.ok(categories.has("morning"), "Should have morning quotes");
  assert.ok(categories.has("celebrate"), "Should have celebrate quotes");

  for (const item of WELFARE_QUOTES) {
    assert.ok(typeof item.quote === "string" && item.quote.length > 0, "Item has quote");
    assert.ok(typeof item.tip === "string" && item.tip.length > 0, "Item has tip");
    assert.ok(typeof item.categoryLabel === "string" && item.categoryLabel.length > 0, "Item has categoryLabel");
    assert.ok(typeof item.color === "string" && item.color.startsWith("#"), "Item has hex color");
    assert.ok(typeof item.emote === "string" && item.emote.length > 0, "Item has emote");
  }
});

test("createPrompt returns properly formatted prompt with id and timestamp", () => {
  const manager = new WelfareManager();
  const prompt = manager.createPrompt("hydrate");
  assert.ok(prompt.id.startsWith("welfare-"), "Prompt has welfare prefix id");
  assert.equal(prompt.category, "hydrate");
  assert.ok(prompt.quote.length > 0);
  assert.ok(prompt.tip.length > 0);
  assert.ok(prompt.timestamp > 0);
});

test("snooze suppresses welfare check until snooze period has elapsed", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
    welfareIntervalMinutes: 20,
    welfareBreakReminders: true,
    welfareHydrationReminders: true,
    welfarePostureReminders: true,
  };

  const baseTime = new Date(2026, 9, 10, 14, 0, 0).getTime();
  // Initialize last prompt time into the past
  manager["lastPromptTime"] = baseTime - 30 * 60 * 1000;
  manager["lastActivityCheck"] = baseTime;

  // Snooze for 15 minutes
  manager.snooze(15, baseTime);

  // Check 5 minutes later (still snoozed)
  const duringSnooze = manager.check(baseTime + 5 * 60 * 1000);
  assert.equal(duringSnooze, null, "Should return null during snooze");

  // Check 16 minutes later (snooze expired)
  const afterSnooze = manager.check(baseTime + 16 * 60 * 1000);
  assert.ok(afterSnooze !== null, "Should trigger welfare prompt after snooze expires");
});

test("check respects welfareReminders disabled toggle", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: false,
  };
  manager["lastPromptTime"] = Date.now() - 60 * 60 * 1000;
  const prompt = manager.check(Date.now());
  assert.equal(prompt, null, "Should return null when welfareReminders is false");
});

test("check suppresses welfare prompts during active approvals or modal states", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
    welfareIntervalMinutes: 20,
  };
  manager["lastPromptTime"] = Date.now() - 60 * 60 * 1000;

  // Simulate pending approval
  State.pendingApproval = { requestId: "req-1", sessionId: "s-1", pillId: "agent_antigravity", tool: "bash", command: "npm test" };
  assert.equal(manager.check(Date.now()), null, "Suppressed during pending approval");
  State.pendingApproval = null;

  // Simulate prompt view open
  State.view = "prompt";
  assert.equal(manager.check(Date.now()), null, "Suppressed during prompt view");
  State.view = "overview";
});

test("check detects continuous active session and triggers break reminder", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
    welfareIntervalMinutes: 30,
    welfareBreakReminders: true,
  };

  const dayTime = new Date(2026, 9, 10, 14, 30, 0).getTime();
  manager["lastPromptTime"] = dayTime - 35 * 60 * 1000;
  manager["continuousActiveMs"] = 35 * 60 * 1000; // 35 minutes continuous active time
  manager["lastActivityCheck"] = dayTime;

  const prompt = manager.check(dayTime);
  assert.ok(prompt !== null, "Prompt should be generated");
  assert.equal(prompt.category, "break", "Should prioritize break prompt for long continuous session");
});

test("check detects late night hours and triggers night owl alert", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
    welfareIntervalMinutes: 20,
    welfareNightOwlAlerts: true,
  };

  // Create date at 23:30 (11:30 PM)
  const lateNightDate = new Date(2026, 9, 10, 23, 30, 0);
  const now = lateNightDate.getTime();
  manager["lastPromptTime"] = now - 30 * 60 * 1000;
  manager["lastActivityCheck"] = now;

  const prompt = manager.check(now);
  assert.ok(prompt !== null, "Prompt should be generated");
  assert.equal(prompt.category, "night", "Should trigger night alert late at night");
});

test("singleton welfareManager instance is exported and functional", () => {
  assert.ok(welfareManager instanceof WelfareManager);
  assert.ok(typeof welfareManager.snooze === "function");
  assert.ok(typeof welfareManager.check === "function");
  assert.ok(typeof welfareManager.startFocus === "function");
  assert.ok(typeof welfareManager.startBreak === "function");
  assert.ok(typeof welfareManager.pauseSprint === "function");
  assert.ok(typeof welfareManager.resumeSprint === "function");
  assert.ok(typeof welfareManager.stopSprint === "function");
  assert.ok(typeof welfareManager.getPomodoroStatus === "function");
});

test("Pomodoro: startFocus initializes focus sprint and tracks status", () => {
  const manager = new WelfareManager();
  const startTime = new Date(2026, 9, 10, 10, 0, 0).getTime();

  const prompt = manager.startFocus(25, startTime);
  assert.ok(prompt.id.startsWith("welfare-focus-"));
  assert.equal(prompt.category, "focus");

  const status = manager.getPomodoroStatus(startTime);
  assert.equal(status.phase, "focus");
  assert.equal(status.remainingFormatted, "25:00");
  assert.equal(status.isPaused, false);
  assert.equal(status.progress, 0);

  // 10 minutes elapsed
  const tenMinsLater = startTime + 10 * 60 * 1000;
  const midStatus = manager.getPomodoroStatus(tenMinsLater);
  assert.equal(midStatus.phase, "focus");
  assert.equal(midStatus.remainingFormatted, "15:00");
  assert.equal(midStatus.progress, 0.4);
  manager.stopSprint();
});

test("Pomodoro: pauseSprint and resumeSprint maintain remaining time", () => {
  const manager = new WelfareManager();
  const startTime = new Date(2026, 9, 10, 10, 0, 0).getTime();

  manager.startFocus(25, startTime);

  // 5 minutes in, pause sprint
  const pauseTime = startTime + 5 * 60 * 1000;
  manager.pauseSprint(pauseTime);

  const pausedStatus = manager.getPomodoroStatus(pauseTime + 20 * 60 * 1000);
  assert.equal(pausedStatus.isPaused, true);
  assert.equal(pausedStatus.remainingFormatted, "20:00");

  // Resume 20 minutes later (wall-clock)
  const resumeTime = pauseTime + 20 * 60 * 1000;
  manager.resumeSprint(resumeTime);

  const resumedStatus = manager.getPomodoroStatus(resumeTime);
  assert.equal(resumedStatus.isPaused, false);
  assert.equal(resumedStatus.remainingFormatted, "20:00");
  manager.stopSprint();
});

test("Pomodoro: check suppresses random welfare prompts during active focus", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
    welfareIntervalMinutes: 15,
    welfareBreakReminders: true,
    welfareHydrationReminders: true,
  };

  const startTime = new Date(2026, 9, 10, 14, 0, 0).getTime();
  manager.startFocus(25, startTime);
  manager["lastPromptTime"] = startTime - 30 * 60 * 1000;

  // 10 minutes in, normal welfare would trigger, but focus sprint should suppress it
  const prompt = manager.check(startTime + 10 * 60 * 1000);
  assert.equal(prompt, null, "Should suppress random welfare checks during active focus");
  manager.stopSprint();
});

test("Pomodoro: check detects sprint completion, emits celebration prompt, and increments cycles", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
  };

  const startTime = new Date(2026, 9, 10, 14, 0, 0).getTime();
  manager.startFocus(25, startTime);

  // 25 minutes + 1 second later: sprint finishes
  const doneTime = startTime + 25 * 60 * 1000 + 1000;
  const prompt = manager.check(doneTime);
  assert.ok(prompt !== null, "Should emit completion prompt when sprint finishes");
  assert.equal(prompt.category, "focus");
  assert.ok(prompt.quote.includes("Focus sprint completed"));

  const status = manager.getPomodoroStatus(doneTime);
  assert.equal(status.phase, "idle");
  assert.equal(status.completedCycles, 1);
});

test("Pomodoro: startBreak and check handle break completion", () => {
  const manager = new WelfareManager();
  State.settings = {
    ...DEFAULT_SETTINGS,
    welfareReminders: true,
  };

  const startTime = new Date(2026, 9, 10, 15, 0, 0).getTime();
  manager.startBreak(5, startTime);

  const status = manager.getPomodoroStatus(startTime);
  assert.equal(status.phase, "break");
  assert.equal(status.remainingFormatted, "5:00");

  // 5 minutes later
  const doneTime = startTime + 5 * 60 * 1000 + 1000;
  const prompt = manager.check(doneTime);
  assert.ok(prompt !== null, "Should emit break finished prompt");
  assert.equal(prompt.category, "break");

  const endStatus = manager.getPomodoroStatus(doneTime);
  assert.equal(endStatus.phase, "idle");
});
