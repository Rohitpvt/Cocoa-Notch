// Staging Shelf View — Stash files/patches/artifacts from the notch.
// Allows copying file paths, asking AI questions, or managing staged files.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type ShelfItem } from "../core/state";
import { card, type ViewActions, type ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

function formatFileSize(bytes?: number): string {
  if (bytes == null || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return t("Just now");
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86400);
  return `${days}d ago`;
}

export function buildShelf(actions: ViewActions): ViewHost {
  const titleText = h("span", { class: "shelf-title-text", text: "Staged Files (Shelf)" });
  const countBadge = h("span", { class: "shelf-count-badge", text: "0" });

  const clearAllBtn = h(
    "button",
    {
      class: "shelf-clear-all-btn",
      title: tl("Clear all"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        State.clearShelf();
      },
    },
    svg(ICONS.trash, 10),
    h("span", { text: t("Clear all") }),
  );

  const header = h(
    "div",
    { class: "shelf-header" },
    h("div", { class: "shelf-title-group" }, svg(ICONS.plus, 12), titleText, countBadge),
    clearAllBtn,
  );

  const listContainer = h("div", { class: "shelf-list" });

  const emptyState = h(
    "div",
    { class: "shelf-empty-state" },
    h("div", { class: "shelf-empty-icon" }, svg(ICONS.plus, 22)),
    h("div", { class: "shelf-empty-title", text: "Shelf is empty" }),
    h("div", { class: "shelf-empty-sub", text: "Drop files on the notch and choose Park on Shelf to hold them here" }),
  );

  const cardBody = h(
    "div",
    { class: "shelf-card-body" },
    header,
    listContainer,
    emptyState,
  );

  const el = h("div", { class: "view shelf-view" }, card(null, cardBody));

  function renderItem(item: ShelfItem): HTMLElement {
    const nameEl = h("span", { class: "shelf-item-name", text: item.name });
    const sizeText = formatFileSize(item.size);
    const timeText = formatRelativeTime(item.timestamp);
    const metaEl = h("span", { class: "shelf-item-meta", text: sizeText ? `${sizeText} • ${timeText}` : timeText });

    const askAiBtn = h(
      "button",
      {
        class: "shelf-item-action-btn",
        title: "Ask AI",
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          State.droppedFile = { name: item.name, path: item.path ?? "", size: item.size ?? 0 };
          actions.setView("prompt");
        },
      },
      h("span", { text: "Ask AI 💬" }),
    );

    const copyBtn = h(
      "button",
      {
        class: "shelf-item-action-btn secondary",
        title: tl("Copy"),
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          const p = item.path || item.name;
          if (navigator?.clipboard?.writeText && p) {
            void navigator.clipboard.writeText(p);
          }
        },
      },
      h("span", { text: t("Copy") }),
    );

    const dismissBtn = h(
      "button",
      {
        class: "shelf-item-dismiss",
        title: tl("Dismiss"),
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          State.removeShelfFile(item.id);
        },
      },
      svg(ICONS.xmark, 8),
    );

    return h(
      "div",
      { class: "shelf-item" },
      h("div", { class: "shelf-item-info" }, nameEl, metaEl),
      h("div", { class: "shelf-item-actions" }, askAiBtn, copyBtn, dismissBtn),
    );
  }

  return {
    el,
    sync() {
      const items = State.shelfFiles;
      countBadge.textContent = String(items.length);
      clearAllBtn.style.display = items.length > 0 ? "flex" : "none";
      emptyState.style.display = items.length === 0 ? "flex" : "none";
      listContainer.style.display = items.length > 0 ? "flex" : "none";

      clear(listContainer);
      for (const item of items) {
        listContainer.append(renderItem(item));
      }
    },
  };
}

