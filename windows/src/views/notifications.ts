// Notification History View — 4th section in the expanded notch island.
// Lists past system toast notifications with timestamps, app badges, and dismiss/clear controls.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type SystemNotification } from "../core/state";
import { card, type ViewActions, type ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return t("Just now");
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86400);
  return `${days}d ago`;
}

export function buildNotificationHistory(actions: ViewActions): ViewHost {
  const titleText = h("span", { class: "notifs-title-text", text: t("Notifications") });
  const countBadge = h("span", { class: "notifs-count-badge", text: "0" });

  const clearAllBtn = h(
    "button",
    {
      class: "notifs-clear-all-btn",
      title: tl("Clear all notifications"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        State.clearNotificationHistory();
      },
    },
    svg(ICONS.trash, 10),
    h("span", { text: t("Clear all") }),
  );

  const header = h(
    "div",
    { class: "notifs-header" },
    h("div", { class: "notifs-title-group" }, svg(ICONS.bell, 12), titleText, countBadge),
    clearAllBtn,
  );

  const listContainer = h("div", { class: "notifs-list" });

  const emptyState = h(
    "div",
    { class: "notifs-empty-state" },
    h("div", { class: "notifs-empty-icon" }, svg(ICONS.bell, 22)),
    h("div", { class: "notifs-empty-title", text: t("No notifications yet") }),
    h("div", { class: "notifs-empty-sub", text: t("System alerts from your apps will appear here") }),
  );

  const cardBody = h(
    "div",
    { class: "notifs-card-body" },
    header,
    listContainer,
    emptyState,
  );

  const el = h("div", { class: "view notifs-view" }, card(null, cardBody));

  function renderItem(n: SystemNotification): HTMLElement {
    const dotEl = h("div", { class: "notif-item-dot" });
    const appEl = h("span", { class: "notif-item-app", text: n.appName || "SYSTEM" });
    const timeEl = h("span", { class: "notif-item-time", text: formatRelativeTime(n.timestamp || Date.now()) });

    const dismissBtn = h(
      "button",
      {
        class: "notif-item-dismiss",
        title: tl("Dismiss"),
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          State.removeSystemNotification(n.id, n.timestamp);
        },
      },
      svg(ICONS.xmark, 8),
    );

    const itemHeader = h("div", { class: "notif-item-header" }, dotEl, appEl, timeEl, dismissBtn);
    const titleEl = h("div", { class: "notif-item-title", text: n.title || "" });
    const bodyEl = n.body ? h("div", { class: "notif-item-body", text: n.body }) : null;

    return h(
      "div",
      {
        class: "notif-item",
        onclick: (e) => {
          e.stopPropagation();
        },
      },
      itemHeader,
      titleEl,
      bodyEl,
    );
  }

  return {
    el,
    sync() {
      const items = State.notificationHistory;
      countBadge.textContent = String(items.length);
      clearAllBtn.style.display = items.length > 0 ? "inline-flex" : "none";

      if (items.length === 0) {
        listContainer.style.display = "none";
        emptyState.style.display = "flex";
        clear(listContainer);
      } else {
        listContainer.style.display = "flex";
        emptyState.style.display = "none";
        clear(listContainer);
        for (const item of items) {
          listContainer.append(renderItem(item));
        }
      }
    },
  };
}
