// Dynamic Island Music & Synced Lyrics View for Cocoa Notch
// Supports live scrubbing, media controls (Play/Pause, Prev, Next, Seek),
// and synchronized karaoke-style lyrics powered by LRCLIB.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type MusicPlaybackState } from "../core/state";
import { card, type ViewActions, type ViewHost } from "./views";
import { Bridge } from "../core/bridge";
import { t, tl } from "../i18n/i18n";
import { fetchLyrics, getActiveLyricIndex, type LyricsData } from "../core/lyrics";

export function buildMusic(actions: ViewActions): ViewHost {
  let activeTab: "player" | "lyrics" = "player";
  let currentLyrics: LyricsData | null = null;
  let lyricsLoading = false;
  let lastFetchedKey = "";
  let lastTrackKey = "";
  let lastReportedPlaying = false;
  let userSeekingUntilMs = 0;
  let isDraggingScrubber = false;
  let lastSyncTimeMs = performance.now();
  let basePositionSecs = 0;
  let activeLyricIdx = -1;
  let userScrollUntilMs = 0;

  // Header Elements
  const appBadgeText = h("span", { class: "music-app-name", text: "Spotify" });
  const appBadge = h(
    "div",
    { class: "music-app-badge" },
    h("span", { class: "music-pulse-dot" }),
    appBadgeText,
  );

  const tabPlayerBtn = h("button", {
    class: "music-tab-btn on",
    text: t("Player"),
    onclick: (e) => {
      e.stopPropagation();
      actions.blip();
      setTab("player");
    },
  });

  const tabLyricsBtn = h("button", {
    class: "music-tab-btn",
    text: t("Lyrics"),
    onclick: (e) => {
      e.stopPropagation();
      actions.blip();
      setTab("lyrics");
    },
  });

  const tabGroup = h("div", { class: "music-tab-group" }, tabPlayerBtn, tabLyricsBtn);

  const closeBtn = h(
    "button",
    {
      class: "music-close-btn",
      title: tl("Close"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        actions.setView("overview");
      },
    },
    svg(ICONS.xmark, 10),
  );

  const header = h("div", { class: "music-header" }, appBadge, tabGroup, closeBtn);
  const contentContainer = h("div", { class: "music-content" });

  const cardBody = h("div", { class: "music-card-body" }, header, contentContainer);
  const el = h("div", { class: "view music-view" }, card(null, cardBody));

  // Player Elements
  const avatarSlot = h("div", { class: "music-player-avatar-slot" });

  const titleEl = h("div", { class: "music-player-title", text: t("No track playing") });
  const artistEl = h("div", { class: "music-player-artist", text: "" });

  const timeElapsedEl = h("span", { class: "music-time-label elapsed", text: "00:00" });
  const timeTotalEl = h("span", { class: "music-time-label total", text: "00:00" });

  const progressFill = h("div", { class: "music-progress-fill" });
  const progressThumb = h("div", { class: "music-progress-thumb" });
  const progressBar = h("div", { class: "music-progress-bar" }, progressFill, progressThumb);
  const progressRow = h("div", { class: "music-progress-row" }, timeElapsedEl, progressBar, timeTotalEl);

  const prevBtn = h(
    "button",
    {
      class: "music-ctrl-btn",
      title: tl("Previous track"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        userSeekingUntilMs = performance.now() + 1200;
        basePositionSecs = 0;
        lastSyncTimeMs = performance.now();
        updateProgressUi(0, State.musicPlayback?.durationSecs || 0);
        void Bridge.mediaPrev?.();
      },
    },
    svg(ICONS.chevronLeft, 14),
  );

  const playPauseIcon = h("span", { class: "music-play-pause-icon", text: "▶" });
  const playPauseBtn = h(
    "button",
    {
      class: "music-ctrl-btn primary play-pause",
      title: tl("Play"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        const music = State.musicPlayback;
        if (music) {
          const nextPlaying = !music.isPlaying;
          const now = performance.now();
          if (!nextPlaying) {
            basePositionSecs = Math.min(music.durationSecs || 0, basePositionSecs + (now - lastSyncTimeMs) / 1000);
            lastSyncTimeMs = now;
          } else {
            lastSyncTimeMs = now;
          }
          State.setMusicPlayback({ ...music, isPlaying: nextPlaying });
        }
        void Bridge.mediaPlayPause?.();
      },
    },
    playPauseIcon,
  );

  const nextBtn = h(
    "button",
    {
      class: "music-ctrl-btn",
      title: tl("Next track"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        userSeekingUntilMs = performance.now() + 1200;
        basePositionSecs = 0;
        lastSyncTimeMs = performance.now();
        updateProgressUi(0, State.musicPlayback?.durationSecs || 0);
        void Bridge.mediaNext?.();
      },
    },
    svg(ICONS.chevronRight, 14),
  );

  const controlsRow = h("div", { class: "music-controls-row" }, prevBtn, playPauseBtn, nextBtn);

  const playerPanel = h(
    "div",
    { class: "music-player-panel" },
    avatarSlot,
    h("div", { class: "music-player-info-col" }, titleEl, artistEl, progressRow, controlsRow),
  );

  // Lyrics Elements
  const lyricsAvatarSlot = h("div", { class: "music-player-avatar-slot" });
  const lyricsList = h("div", { class: "music-lyrics-list" });
  const lyricsPanel = h("div", { class: "music-lyrics-panel" }, lyricsAvatarSlot, lyricsList);

  lyricsList.addEventListener("wheel", () => {
    userScrollUntilMs = performance.now() + 3000;
  }, { passive: true });
  lyricsList.addEventListener("touchstart", () => {
    userScrollUntilMs = performance.now() + 3000;
  }, { passive: true });

  function scrollToActiveLyric(lineEl: HTMLElement, smooth = true) {
    if (!lineEl || !lyricsList) return;
    const listRect = lyricsList.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();
    if (listRect.height <= 0) return;

    const currentRelTop = lineRect.top - listRect.top;
    const targetRelTop = (listRect.height - lineRect.height) / 2;
    const delta = currentRelTop - targetRelTop;

    if (Math.abs(delta) < 2) return;

    lyricsList.scrollTo({
      top: Math.max(0, lyricsList.scrollTop + delta),
      behavior: smooth ? "smooth" : "auto",
    });
  }

  function updateLyricsHighlight(currentPos: number, smooth = true) {
    if (activeTab !== "lyrics" || !currentLyrics || currentLyrics.lines.length === 0) return;
    const idx = getActiveLyricIndex(currentLyrics.lines, currentPos);
    if (idx !== activeLyricIdx) {
      activeLyricIdx = idx;
      const lines = lyricsList.querySelectorAll<HTMLElement>(".music-lyric-line");
      lines.forEach((l, i) => {
        const isActive = i === idx;
        l.classList.toggle("active", isActive);
        if (isActive) {
          const isUserScrolling = performance.now() < userScrollUntilMs;
          if (!isUserScrolling) {
            scrollToActiveLyric(l, smooth);
          }
        }
      });
    }
  }

  // Scrubber click / drag seeking
  function seekFromEvent(e: MouseEvent | PointerEvent) {
    const music = State.musicPlayback;
    const duration = music?.durationSecs || 0;
    if (duration <= 0) return 0;

    const rect = progressBar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = clickX / rect.width;
    const targetSecs = Math.max(0, Math.min(duration, ratio * duration));

    basePositionSecs = targetSecs;
    lastSyncTimeMs = performance.now();
    updateProgressUi(targetSecs, duration);
    return targetSecs;
  }

  progressBar.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    isDraggingScrubber = true;
    progressBar.classList.add("dragging");
    try {
      progressBar.setPointerCapture?.(e.pointerId);
    } catch {}
    userSeekingUntilMs = performance.now() + 2000;
    seekFromEvent(e);
  });

  progressBar.addEventListener("pointermove", (e) => {
    if (!isDraggingScrubber) return;
    e.stopPropagation();
    userSeekingUntilMs = performance.now() + 2000;
    seekFromEvent(e);
  });

  const finishDrag = (e: PointerEvent) => {
    if (!isDraggingScrubber) return;
    isDraggingScrubber = false;
    progressBar.classList.remove("dragging");
    e.stopPropagation();
    try {
      progressBar.releasePointerCapture?.(e.pointerId);
    } catch {}
    userSeekingUntilMs = performance.now() + 2000;
    const targetSecs = seekFromEvent(e);
    if (targetSecs != null) {
      actions.blip();
      void Bridge.mediaSeek?.(targetSecs);
    }
  };

  progressBar.addEventListener("pointerup", finishDrag);
  progressBar.addEventListener("pointercancel", finishDrag);

  function setTab(tab: "player" | "lyrics") {
    activeTab = tab;
    tabPlayerBtn.classList.toggle("on", tab === "player");
    tabLyricsBtn.classList.toggle("on", tab === "lyrics");
    clear(contentContainer);
    if (tab === "player") {
      contentContainer.append(playerPanel);
    } else {
      contentContainer.append(lyricsPanel);
      activeLyricIdx = -1;
      userScrollUntilMs = 0;
      renderLyrics();
      if (!currentLyrics && !lyricsLoading && State.musicPlayback) {
        checkLyricsFetch(State.musicPlayback, true);
      }
      const pos = State.musicPlayback?.positionSecs || basePositionSecs || 0;
      updateLyricsHighlight(pos, false);
    }
  }

  function formatTime(secs: number): string {
    if (!secs || isNaN(secs) || secs < 0) return "00:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  function updateProgressUi(pos: number, duration: number) {
    timeElapsedEl.textContent = formatTime(pos);
    timeTotalEl.textContent = formatTime(duration);
    const pct = duration > 0 ? Math.min(100, Math.max(0, (pos / duration) * 100)) : 0;
    progressFill.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
  }

  function renderLyrics() {
    clear(lyricsList);
    const music = State.musicPlayback;

    if (!music || !music.title) {
      lyricsList.append(h("div", { class: "music-lyrics-empty", text: t("No track playing") }));
      return;
    }

    if (lyricsLoading) {
      lyricsList.append(h("div", { class: "music-lyrics-empty", text: t("Loading synchronized lyrics...") }));
      return;
    }

    if (!currentLyrics || currentLyrics.isInstrumental || (currentLyrics.lines.length === 0 && !currentLyrics.plainLyrics)) {
      lyricsList.append(h("div", { class: "music-lyrics-empty", text: t("♪ Lyrics not available for this track ♪") }));
      return;
    }

    const color = music.albumColor || "#1DB954";
    lyricsList.style.setProperty("--music-accent", color);
    lyricsList.style.setProperty("--album-accent", color);

    if (currentLyrics.lines.length > 0) {
      for (let i = 0; i < currentLyrics.lines.length; i++) {
        const line = currentLyrics.lines[i];
        const lineEl = h("div", {
          class: `music-lyric-line${i === activeLyricIdx ? " active" : ""}`,
          text: line.text || "♪",
          onclick: (e) => {
            e.stopPropagation();
            actions.blip();
            userSeekingUntilMs = performance.now() + 1500;
            userScrollUntilMs = 0;
            basePositionSecs = line.timeSecs;
            lastSyncTimeMs = performance.now();
            updateProgressUi(line.timeSecs, State.musicPlayback?.durationSecs || 0);
            void Bridge.mediaSeek?.(line.timeSecs);
            activeLyricIdx = -1;
            updateLyricsHighlight(line.timeSecs, true);
          },
        });
        lyricsList.append(lineEl);
      }
      const pos = State.musicPlayback?.positionSecs || basePositionSecs || 0;
      activeLyricIdx = -1;
      requestAnimationFrame(() => {
        updateLyricsHighlight(pos, false);
      });
    } else if (currentLyrics.plainLyrics) {
      const rawLines = currentLyrics.plainLyrics.split(/\r?\n/);
      for (const rawLine of rawLines) {
        const text = rawLine.trim();
        if (!text) {
          lyricsList.append(h("div", { class: "music-lyric-spacer" }));
        } else {
          lyricsList.append(h("div", { class: "music-lyric-line plain", text }));
        }
      }
    }
  }

  function checkLyricsFetch(music: MusicPlaybackState | null, force = false) {
    if (!music || !music.title) {
      currentLyrics = null;
      lastFetchedKey = "";
      return;
    }

    const key = `${music.artist || ""}:::${music.title}`;
    if (!force && key === lastFetchedKey) return;

    lastFetchedKey = key;
    lyricsLoading = true;
    activeLyricIdx = -1;
    if (activeTab === "lyrics") renderLyrics();

    void fetchLyrics(music.title, music.artist || "", music.durationSecs)
      .then((data) => {
        if (key === lastFetchedKey) {
          currentLyrics = data;
          lyricsLoading = false;
          activeLyricIdx = -1;
          if (activeTab === "lyrics") renderLyrics();
        }
      })
      .catch(() => {
        if (key === lastFetchedKey) {
          currentLyrics = null;
          lyricsLoading = false;
          activeLyricIdx = -1;
          if (activeTab === "lyrics") renderLyrics();
        }
      });
  }

  return {
    el,
    sync() {
      const music = State.musicPlayback;
      const isPlaying = music?.isPlaying === true;
      const color = music?.albumColor || "#1DB954";

      // Accent colors
      el.style.setProperty("--album-accent", color);

      // Header App Name
      const appName = music?.appName || "Spotify";
      appBadgeText.textContent = appName;
      appBadge.classList.toggle("playing", isPlaying);

      // Play / Pause Icon & Tooltip
      playPauseIcon.textContent = isPlaying ? "⏸" : "▶";
      playPauseBtn.title = isPlaying ? t("Pause") : t("Play");

      if (music && music.title) {
        titleEl.textContent = music.title;
        artistEl.textContent = music.artist
          ? `${music.artist}${music.albumTitle ? ` · ${music.albumTitle}` : ""}`
          : "";

        const trackKey = `${music.artist || ""}:::${music.title}`;
        const trackChanged = trackKey !== lastTrackKey;
        const playStateChanged = music.isPlaying !== lastReportedPlaying;
        lastTrackKey = trackKey;
        lastReportedPlaying = music.isPlaying === true;

        const incomingPos = music.positionSecs || 0;
        const duration = music.durationSecs || 0;
        const now = performance.now();

        if (isDraggingScrubber) {
          // Keep dragging position untouched
        } else if (now > userSeekingUntilMs) {
          const currentInterpolated = basePositionSecs + (isPlaying ? (now - lastSyncTimeMs) / 1000 : 0);
          const drift = Math.abs(currentInterpolated - incomingPos);

          // Snap if track changed, playback toggled, or drift is significant (> 1.5s)
          if (trackChanged || playStateChanged || drift > 1.5 || basePositionSecs === 0) {
            basePositionSecs = incomingPos;
            lastSyncTimeMs = now;
            updateProgressUi(basePositionSecs, duration);
          }
        }

        checkLyricsFetch(music);
        if (activeTab === "lyrics") {
          updateLyricsHighlight(basePositionSecs, false);
        }
      } else {
        lastTrackKey = "";
        lastReportedPlaying = false;
        basePositionSecs = 0;
        titleEl.textContent = t("No track playing");
        artistEl.textContent = t("Play music in Spotify or any app");
        updateProgressUi(0, 0);
      }

      if (!contentContainer.hasChildNodes()) {
        contentContainer.append(activeTab === "player" ? playerPanel : lyricsPanel);
      }
    },
    tick(nowMs: number) {
      const music = State.musicPlayback;
      if (!music || !music.isPlaying || isDraggingScrubber) return;

      const duration = music.durationSecs || 0;
      if (duration <= 0) return;

      // Smooth interpolation between OS 1s ticks
      const dt = (nowMs - lastSyncTimeMs) / 1000;
      const currentPos = Math.min(duration, basePositionSecs + dt);

      updateProgressUi(currentPos, duration);

      // Synced lyrics highlight & scroll
      updateLyricsHighlight(currentPos, true);

      return true; // request next frame while playing
    },
  };
}
