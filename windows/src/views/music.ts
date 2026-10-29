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
  let lastSyncTimeMs = performance.now();
  let basePositionSecs = 0;
  let activeLyricIdx = -1;

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
  const artImg = h("img", { class: "music-player-art-img", alt: "Album Art" });
  const artFallback = h("div", { class: "music-player-art-fallback", text: "🎵" });
  const artWrap = h("div", { class: "music-player-art-wrap" }, artFallback);

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
          State.setMusicPlayback({ ...music, isPlaying: !music.isPlaying });
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
        void Bridge.mediaNext?.();
      },
    },
    svg(ICONS.chevronRight, 14),
  );

  const controlsRow = h("div", { class: "music-controls-row" }, prevBtn, playPauseBtn, nextBtn);

  const playerPanel = h(
    "div",
    { class: "music-player-panel" },
    artWrap,
    h("div", { class: "music-player-info-col" }, titleEl, artistEl, progressRow, controlsRow),
  );

  // Lyrics Elements
  const lyricsList = h("div", { class: "music-lyrics-list" });
  const lyricsPanel = h("div", { class: "music-lyrics-panel" }, lyricsList);

  // Scrubber click / drag seeking
  progressBar.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.blip();
    const music = State.musicPlayback;
    const duration = music?.durationSecs || 0;
    if (duration <= 0) return;

    const rect = progressBar.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = clickX / rect.width;
    const targetSecs = ratio * duration;

    basePositionSecs = targetSecs;
    lastSyncTimeMs = performance.now();
    updateProgressUi(targetSecs, duration);
    void Bridge.mediaSeek?.(targetSecs);
  });

  function setTab(tab: "player" | "lyrics") {
    activeTab = tab;
    tabPlayerBtn.classList.toggle("on", tab === "player");
    tabLyricsBtn.classList.toggle("on", tab === "lyrics");
    clear(contentContainer);
    if (tab === "player") {
      contentContainer.append(playerPanel);
    } else {
      contentContainer.append(lyricsPanel);
      renderLyrics();
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

    if (!currentLyrics || currentLyrics.isInstrumental || currentLyrics.lines.length === 0) {
      const fallbackText = currentLyrics?.plainLyrics
        ? currentLyrics.plainLyrics
        : t("♪ Lyrics not available for this track ♪");
      lyricsList.append(h("div", { class: "music-lyrics-empty", text: fallbackText }));
      return;
    }

    const color = music.albumColor || "#1DB954";
    lyricsList.style.setProperty("--music-accent", color);

    for (let i = 0; i < currentLyrics.lines.length; i++) {
      const line = currentLyrics.lines[i];
      const lineEl = h("div", {
        class: `music-lyric-line${i === activeLyricIdx ? " active" : ""}`,
        text: line.text || "♪",
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          basePositionSecs = line.timeSecs;
          lastSyncTimeMs = performance.now();
          void Bridge.mediaSeek?.(line.timeSecs);
        },
      });
      lyricsList.append(lineEl);
    }
  }

  function checkLyricsFetch(music: MusicPlaybackState | null) {
    if (!music || !music.title) {
      currentLyrics = null;
      lastFetchedKey = "";
      return;
    }

    const key = `${music.artist || ""}:::${music.title}`;
    if (key === lastFetchedKey) return;

    lastFetchedKey = key;
    lyricsLoading = true;
    activeLyricIdx = -1;
    if (activeTab === "lyrics") renderLyrics();

    void fetchLyrics(music.title, music.artist || "", music.durationSecs)
      .then((data) => {
        if (key === lastFetchedKey) {
          currentLyrics = data;
          lyricsLoading = false;
          if (activeTab === "lyrics") renderLyrics();
        }
      })
      .catch(() => {
        if (key === lastFetchedKey) {
          currentLyrics = null;
          lyricsLoading = false;
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
      playPauseBtn.title = t(isPlaying ? "Pause" : "Play");

      if (music && music.title) {
        titleEl.textContent = music.title;
        artistEl.textContent = music.artist
          ? `${music.artist}${music.albumTitle ? ` · ${music.albumTitle}` : ""}`
          : "";

        // Album Art
        clear(artWrap);
        if (music.albumArtUrl) {
          artImg.src = music.albumArtUrl;
          artWrap.append(artImg);
        } else {
          artWrap.append(artFallback);
        }
        artWrap.style.boxShadow = `0 4px 20px ${color}40`;
        artWrap.style.borderColor = `${color}55`;

        basePositionSecs = music.positionSecs || 0;
        lastSyncTimeMs = performance.now();
        updateProgressUi(basePositionSecs, music.durationSecs || 0);

        checkLyricsFetch(music);
      } else {
        titleEl.textContent = t("No track playing");
        artistEl.textContent = t("Play music in Spotify or any app");
        updateProgressUi(0, 0);
        clear(artWrap);
        artWrap.append(artFallback);
        artWrap.style.boxShadow = "none";
        artWrap.style.borderColor = "rgba(255,255,255,0.08)";
      }

      if (!contentContainer.hasChildNodes()) {
        contentContainer.append(activeTab === "player" ? playerPanel : lyricsPanel);
      }
    },
    tick(nowMs: number) {
      const music = State.musicPlayback;
      if (!music || !music.isPlaying) return;

      const duration = music.durationSecs || 0;
      if (duration <= 0) return;

      // Smooth interpolation between OS 1s ticks
      const dt = (nowMs - lastSyncTimeMs) / 1000;
      const currentPos = Math.min(duration, basePositionSecs + dt);

      updateProgressUi(currentPos, duration);

      // Synced lyrics highlight & scroll
      if (activeTab === "lyrics" && currentLyrics && currentLyrics.lines.length > 0) {
        const idx = getActiveLyricIndex(currentLyrics.lines, currentPos);
        if (idx !== activeLyricIdx) {
          activeLyricIdx = idx;
          const lines = lyricsList.querySelectorAll(".music-lyric-line");
          lines.forEach((l, i) => {
            const isActive = i === idx;
            l.classList.toggle("active", isActive);
            if (isActive) {
              const elTop = (l as HTMLElement).offsetTop;
              const containerH = lyricsList.clientHeight;
              lyricsList.scrollTo({
                top: Math.max(0, elTop - containerH / 2 + 16),
                behavior: "smooth",
              });
            }
          });
        }
      }

      return true; // request next frame while playing
    },
  };
}
