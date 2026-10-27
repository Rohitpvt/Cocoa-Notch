// Mochi Welfare & Wellness system: intelligent proactive comments for breaks,
// hydration, posture, late night coding, and wellness quotes.

import { State } from "./state";
import { N_, t } from "../i18n/i18n";
import type { BotEmoteName } from "./layout";

export type WelfareCategory = "break" | "hydrate" | "posture" | "night" | "morning" | "celebrate" | "focus";

export type PomodoroPhase = "idle" | "focus" | "break";

export interface PomodoroStatus {
  phase: PomodoroPhase;
  remainingMs: number;
  remainingFormatted: string;
  progress: number;
  isPaused: boolean;
  completedCycles: number;
}

export function formatSprintDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export interface WelfareItem {
  category: WelfareCategory;
  categoryLabel: string;
  quote: string;
  tip: string;
  emote: BotEmoteName;
  color: string;
}

export interface WelfarePrompt extends WelfareItem {
  id: string;
  timestamp: number;
}

export const WELFARE_QUOTES: readonly WelfareItem[] = [
  // ── Breaks & Rest ──
  {
    category: "break",
    categoryLabel: N_("Break Time"),
    quote: N_("Time for a breather!"),
    tip: N_("You've been working hard. Stretch your arms and give your eyes a quick rest."),
    emote: "happy",
    color: "#22c55e",
  },
  {
    category: "break",
    categoryLabel: N_("Break Time"),
    quote: N_("Have a break, it's been a long session!"),
    tip: N_("Step away from the screen for a few minutes. Your brain will thank you."),
    emote: "yawn",
    color: "#22c55e",
  },
  {
    category: "break",
    categoryLabel: N_("Break Time"),
    quote: N_("Coding break time!"),
    tip: N_("Stand up, stretch your legs, and take a couple of deep breaths."),
    emote: "wink",
    color: "#22c55e",
  },

  // ── Hydration ──
  {
    category: "hydrate",
    categoryLabel: N_("Hydration"),
    quote: N_("Hydration check!"),
    tip: N_("Grab a fresh glass of water. Stay refreshed while you build."),
    emote: "love",
    color: "#38bdf8",
  },
  {
    category: "hydrate",
    categoryLabel: N_("Hydration"),
    quote: N_("Time to drink some water!"),
    tip: N_("A quick sip of water keeps your focus sharp and your energy high."),
    emote: "happy",
    color: "#38bdf8",
  },

  // ── Posture & Eye Care ──
  {
    category: "posture",
    categoryLabel: N_("Posture & Eyes"),
    quote: N_("Posture check!"),
    tip: N_("Roll your shoulders back, straighten your spine, and relax your neck."),
    emote: "proud",
    color: "#a855f7",
  },
  {
    category: "posture",
    categoryLabel: N_("Posture & Eyes"),
    quote: N_("20-20-20 eye rest!"),
    tip: N_("Look at an object 20 feet away for 20 seconds to ease eye strain."),
    emote: "wink",
    color: "#a855f7",
  },

  // ── Late Night ──
  {
    category: "night",
    categoryLabel: N_("Night Owl"),
    quote: N_("Burning the midnight oil?"),
    tip: N_("It's getting late! Your code will still be here tomorrow — get some rest soon."),
    emote: "yawn",
    color: "#f59e0b",
  },
  {
    category: "night",
    categoryLabel: N_("Night Owl"),
    quote: N_("Time to wind down!"),
    tip: N_("Great progress tonight. Remember that good sleep makes great code."),
    emote: "yawn",
    color: "#f59e0b",
  },

  // ── Early Morning ──
  {
    category: "morning",
    categoryLabel: N_("Good Morning"),
    quote: N_("Good morning, builder!"),
    tip: N_("Ready to create something amazing today? Wishing you smooth coding."),
    emote: "happy",
    color: "#eab308",
  },
  {
    category: "morning",
    categoryLabel: N_("Good Morning"),
    quote: N_("Rise and shine!"),
    tip: N_("Fresh morning, fresh ideas. Let's make today productive and fun."),
    emote: "proud",
    color: "#eab308",
  },

  // ── Task Completion / Celebration ──
  {
    category: "celebrate",
    categoryLabel: N_("Well Done"),
    quote: N_("Mission accomplished!"),
    tip: N_("Great work wrapping that up! Take a moment to enjoy the win."),
    emote: "proud",
    color: "#ec4899",
  },

  // ── Focus & Pomodoro Sprints ──
  {
    category: "focus",
    categoryLabel: N_("Focus Sprint"),
    quote: N_("Deep work session active!"),
    tip: N_("Locked in and building. Mochi will guard your focus until the sprint ends."),
    emote: "proud",
    color: "#6366f1",
  },
  {
    category: "focus",
    categoryLabel: N_("Focus Sprint Complete"),
    quote: N_("Focus sprint completed! 🎯"),
    tip: N_("Awesome work! You completed your focus sprint. Time for a breather to stretch and hydrate."),
    emote: "happy",
    color: "#6366f1",
  },
];

export class WelfareManager {
  private lastPromptTime = Date.now();
  private snoozeUntil = 0;
  private continuousActiveMs = 0;
  private lastActivityCheck = Date.now();
  private lastQuoteIndex = -1;
  private lastCategory: WelfareCategory | null = null;
  private morningGreetedDate: string | null = null;

  // ── Pomodoro Focus Sprint State ──
  private pomodoroPhase: PomodoroPhase = "idle";
  private pomodoroStartTime = 0;
  private pomodoroDurationMs = 25 * 60 * 1000;
  private pomodoroPausedRemainingMs: number | null = null;
  private pomodoroCompletedCycles = 0;
  private sprintTimer: ReturnType<typeof setInterval> | null = null;
  private onSprintChangeCallbacks: Set<() => void> = new Set();
  private onSprintCompleteCallbacks: Set<(prompt: WelfarePrompt) => void> = new Set();

  snooze(minutes = 15, now = Date.now()) {
    this.snoozeUntil = now + minutes * 60 * 1000;
  }

  recordActivity(now = Date.now()) {
    const elapsed = now - this.lastActivityCheck;
    this.lastActivityCheck = now;
    // If idle for more than 5 minutes, reset continuous active streak
    if (elapsed > 5 * 60 * 1000) {
      this.continuousActiveMs = 0;
    } else {
      this.continuousActiveMs += elapsed;
    }
  }

  createPrompt(category?: WelfareCategory, now = Date.now()): WelfarePrompt {
    const quote = this.pickQuote(category);
    this.lastPromptTime = now;
    return {
      id: `welfare-${now}`,
      category: quote.category,
      categoryLabel: t(quote.categoryLabel),
      quote: t(quote.quote),
      tip: t(quote.tip),
      emote: quote.emote,
      color: quote.color,
      timestamp: now,
    };
  }

  pickQuote(requestedCategory?: WelfareCategory): WelfareItem {
    let pool = requestedCategory
      ? WELFARE_QUOTES.filter((q) => q.category === requestedCategory)
      : WELFARE_QUOTES;
    if (pool.length === 0) pool = WELFARE_QUOTES;

    let nextIdx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && nextIdx === this.lastQuoteIndex) {
      nextIdx = (nextIdx + 1) % pool.length;
    }
    this.lastQuoteIndex = nextIdx;
    const chosen = pool[nextIdx];
    this.lastCategory = chosen.category;
    return chosen;
  }

  getPomodoroStatus(now = Date.now()): PomodoroStatus {
    if (this.pomodoroPhase === "idle") {
      return {
        phase: "idle",
        remainingMs: 0,
        remainingFormatted: "0:00",
        progress: 0,
        isPaused: false,
        completedCycles: this.pomodoroCompletedCycles,
      };
    }

    let remainingMs: number;
    const isPaused = this.pomodoroPausedRemainingMs != null;
    if (this.pomodoroPausedRemainingMs != null) {
      remainingMs = this.pomodoroPausedRemainingMs;
    } else {
      const elapsed = now - this.pomodoroStartTime;
      remainingMs = Math.max(0, this.pomodoroDurationMs - elapsed);
    }

    const progress = this.pomodoroDurationMs > 0
      ? Math.min(1, Math.max(0, 1 - remainingMs / this.pomodoroDurationMs))
      : 0;

    return {
      phase: this.pomodoroPhase,
      remainingMs,
      remainingFormatted: formatSprintDuration(remainingMs),
      progress,
      isPaused,
      completedCycles: this.pomodoroCompletedCycles,
    };
  }

  startFocus(durationMinutes?: number, now = Date.now()): WelfarePrompt {
    const mins = durationMinutes || State.settings.welfarePomodoroFocusMinutes || 25;
    this.pomodoroPhase = "focus";
    this.pomodoroStartTime = now;
    this.pomodoroDurationMs = mins * 60 * 1000;
    this.pomodoroPausedRemainingMs = null;
    this.startSprintTimer();
    this.notifySprintChange();

    const prompt: WelfarePrompt = {
      id: `welfare-focus-${now}`,
      category: "focus",
      categoryLabel: t("Focus Sprint"),
      quote: t("Deep work session active! 🎯"),
      tip: t("Focus sprint running. Mochi will protect your deep work and alert you when time is up."),
      emote: "proud",
      color: "#6366f1",
      timestamp: now,
    };
    State.setWelfarePrompt(prompt);
    return prompt;
  }

  startBreak(durationMinutes?: number, now = Date.now()): WelfarePrompt {
    const mins = durationMinutes || State.settings.welfarePomodoroBreakMinutes || 5;
    this.pomodoroPhase = "break";
    this.pomodoroStartTime = now;
    this.pomodoroDurationMs = mins * 60 * 1000;
    this.pomodoroPausedRemainingMs = null;
    this.startSprintTimer();
    this.notifySprintChange();

    const prompt: WelfarePrompt = {
      id: `welfare-break-${now}`,
      category: "break",
      categoryLabel: t("Break Time"),
      quote: t("Time for a breather! ☕"),
      tip: t("Step away from the screen, stretch, and relax your eyes."),
      emote: "happy",
      color: "#22c55e",
      timestamp: now,
    };
    State.setWelfarePrompt(prompt);
    return prompt;
  }

  pauseSprint(now = Date.now()) {
    if (this.pomodoroPhase === "idle" || this.pomodoroPausedRemainingMs != null) return;
    const elapsed = now - this.pomodoroStartTime;
    this.pomodoroPausedRemainingMs = Math.max(0, this.pomodoroDurationMs - elapsed);
    this.stopSprintTimer();
    this.notifySprintChange();
  }

  resumeSprint(now = Date.now()) {
    if (this.pomodoroPhase === "idle" || this.pomodoroPausedRemainingMs == null) return;
    this.pomodoroStartTime = now - (this.pomodoroDurationMs - this.pomodoroPausedRemainingMs);
    this.pomodoroPausedRemainingMs = null;
    this.startSprintTimer();
    this.notifySprintChange();
  }

  stopSprint() {
    this.pomodoroPhase = "idle";
    this.pomodoroPausedRemainingMs = null;
    this.stopSprintTimer();
    this.notifySprintChange();
  }

  onSprintChange(cb: () => void): () => void {
    this.onSprintChangeCallbacks.add(cb);
    return () => this.onSprintChangeCallbacks.delete(cb);
  }

  onSprintComplete(cb: (prompt: WelfarePrompt) => void): () => void {
    this.onSprintCompleteCallbacks.add(cb);
    return () => this.onSprintCompleteCallbacks.delete(cb);
  }

  private notifySprintChange() {
    for (const cb of this.onSprintChangeCallbacks) {
      try {
        cb();
      } catch {}
    }
  }

  private notifySprintComplete(prompt: WelfarePrompt) {
    for (const cb of this.onSprintCompleteCallbacks) {
      try {
        cb(prompt);
      } catch {}
    }
  }

  private startSprintTimer() {
    this.stopSprintTimer();
    if (typeof setInterval === "function") {
      this.sprintTimer = setInterval(() => {
        this.notifySprintChange();
        const prompt = this.check(Date.now());
        if (prompt) {
          this.notifySprintComplete(prompt);
        }
      }, 1000);
    }
  }

  private stopSprintTimer() {
    if (this.sprintTimer != null && typeof clearInterval === "function") {
      clearInterval(this.sprintTimer);
      this.sprintTimer = null;
    }
  }

  check(now = Date.now()): WelfarePrompt | null {
    if (!State.settings.welfareReminders) return null;
    if (now < this.snoozeUntil) return null;
    if (State.pendingApproval || State.view === "prompt") return null;

    // ── Check Pomodoro Focus Sprint Lifecycle ──
    if (this.pomodoroPhase === "focus") {
      if (this.pomodoroPausedRemainingMs == null) {
        const elapsed = now - this.pomodoroStartTime;
        if (elapsed >= this.pomodoroDurationMs) {
          // Focus sprint completed!
          this.pomodoroCompletedCycles++;
          this.pomodoroPhase = "idle";
          this.stopSprintTimer();
          this.notifySprintChange();

          this.lastPromptTime = now;
          const prompt: WelfarePrompt = {
            id: `welfare-sprint-done-${now}`,
            category: "focus",
            categoryLabel: t("Sprint Complete"),
            quote: t("Focus sprint completed! 🎯"),
            tip: t("Awesome focus! Take a 5-minute breather to stretch and hydrate before the next sprint."),
            emote: "proud",
            color: "#6366f1",
            timestamp: now,
          };
          return prompt;
        }
      }
      // Suppress regular random welfare prompts while focusing
      const currentHour = new Date(now).getHours();
      if (State.settings.welfareNightOwlAlerts && (currentHour >= 23 || currentHour < 5)) {
        if (this.lastCategory !== "night") {
          return this.createPrompt("night", now);
        }
      }
      return null;
    }

    if (this.pomodoroPhase === "break") {
      if (this.pomodoroPausedRemainingMs == null) {
        const elapsed = now - this.pomodoroStartTime;
        if (elapsed >= this.pomodoroDurationMs) {
          // Break completed!
          this.pomodoroPhase = "idle";
          this.stopSprintTimer();
          this.notifySprintChange();

          this.lastPromptTime = now;
          const prompt: WelfarePrompt = {
            id: `welfare-break-done-${now}`,
            category: "break",
            categoryLabel: t("Break Finished"),
            quote: t("Break time is up! Ready to roll? ✨"),
            tip: t("Your break is complete. Ready to dive back in or start another focus sprint?"),
            emote: "happy",
            color: "#22c55e",
            timestamp: now,
          };
          return prompt;
        }
      }
      return null;
    }

    this.recordActivity(now);

    const intervalMs = Math.max(15, State.settings.welfareIntervalMinutes || 45) * 60 * 1000;
    const timeSinceLastPrompt = now - this.lastPromptTime;

    if (timeSinceLastPrompt < intervalMs) return null;

    // 1. Long continuous active session -> Break reminder
    if (State.settings.welfareBreakReminders && this.continuousActiveMs >= intervalMs) {
      this.continuousActiveMs = 0;
      return this.createPrompt("break", now);
    }

    const currentHour = new Date(now).getHours();
    const todayStr = new Date(now).toDateString();

    // 2. Late night check (23:00 - 05:00)
    if (State.settings.welfareNightOwlAlerts && (currentHour >= 23 || currentHour < 5)) {
      if (this.lastCategory !== "night") {
        return this.createPrompt("night", now);
      }
    }

    // 3. Early morning check (06:00 - 09:30) once per day
    if (currentHour >= 6 && currentHour <= 9 && this.morningGreetedDate !== todayStr) {
      this.morningGreetedDate = todayStr;
      return this.createPrompt("morning", now);
    }

    // 4. Regular rotation between enabled welfare categories
    const candidates: WelfareCategory[] = [];
    if (State.settings.welfareBreakReminders) candidates.push("break");
    if (State.settings.welfareHydrationReminders) candidates.push("hydrate");
    if (State.settings.welfarePostureReminders) candidates.push("posture");

    if (candidates.length === 0) return null;

    const available = candidates.filter((c) => c !== this.lastCategory);
    const chosenCategory = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : candidates[Math.floor(Math.random() * candidates.length)];

    return this.createPrompt(chosenCategory, now);
  }

  tickPomodoro(now = Date.now()): WelfarePrompt | null {
    if (!State.pomodoro.active || State.pomodoro.paused) return null;
    if (State.pomodoro.remainingSec > 1) {
      State.pomodoro.remainingSec -= 1;
      State.notify();
      return null;
    }

    if (State.pomodoro.phase === "work") {
      State.pomodoro.completedCount += 1;
      State.pomodoro.phase = "break";
      State.pomodoro.totalSec = 5 * 60;
      State.pomodoro.remainingSec = 5 * 60;
      const prompt: WelfarePrompt = {
        id: `pomodoro-${now}`,
        category: "break",
        categoryLabel: t("Break Time"),
        quote: t("Mission accomplished!"),
        tip: t("You've been working hard. Stretch your arms and give your eyes a quick rest."),
        emote: "happy",
        color: "#ef4444",
        timestamp: now,
      };
      State.setWelfarePrompt(prompt);
      return prompt;
    } else if (State.pomodoro.phase === "break") {
      State.pomodoro.phase = "idle";
      State.pomodoro.active = false;
      State.pomodoro.remainingSec = 25 * 60;
      State.pomodoro.totalSec = 25 * 60;
      const prompt: WelfarePrompt = {
        id: `pomodoro-${now}`,
        category: "break",
        categoryLabel: t("Break Time"),
        quote: t("Time for a breather!"),
        tip: t("Rise and shine!"),
        emote: "proud",
        color: "#22c55e",
        timestamp: now,
      };
      State.setWelfarePrompt(prompt);
      return prompt;
    }
    return null;
  }
}

export const welfareManager = new WelfareManager();
