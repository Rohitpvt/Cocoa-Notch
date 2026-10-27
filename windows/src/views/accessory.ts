// Connected Bluetooth Headphone / Earbud Battery View
// Detailed breakdown for connected Bluetooth audio accessories, battery levels,
// multi-earbud (L/R/Case) status, and quick shortcuts to Windows sound settings.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type AccessoryDevice } from "../core/state";
import { card, type ViewActions, type ViewHost } from "./views";
import { Bridge } from "../core/bridge";
import { t, tl } from "../i18n/i18n";

export function buildAccessory(actions: ViewActions): ViewHost {
  const titleText = h("span", { class: "accessory-title-text", text: t("Bluetooth Audio") });
  const statusBadge = h("span", { class: "accessory-status-badge connected", text: t("Connected") });

  const closeBtn = h(
    "button",
    {
      class: "accessory-close-btn",
      title: tl("Close"),
      onclick: (e) => {
        e.stopPropagation();
        actions.blip();
        actions.setView("overview");
      },
    },
    svg(ICONS.xmark, 10),
  );

  const header = h(
    "div",
    { class: "accessory-header" },
    h("div", { class: "accessory-title-group" }, h("span", { class: "accessory-icon-badge", text: "🎧" }), titleText, statusBadge),
    closeBtn,
  );

  const contentContainer = h("div", { class: "accessory-content" });

  const cardBody = h(
    "div",
    { class: "accessory-card-body" },
    header,
    contentContainer,
  );

  const el = h("div", { class: "view accessory-view" }, card(null, cardBody));

  function renderConnected(dev: AccessoryDevice): HTMLElement {
    const isLow = dev.battery <= 20;
    const bColor = isLow ? "#f87171" : dev.battery <= 40 ? "#fbbf24" : "#38bdf8";

    // Top info row
    const nameEl = h("div", { class: "accessory-dev-name", text: dev.name });
    const kindEl = h("div", { class: "accessory-dev-kind", text: dev.kind === "earbuds" ? t("Wireless Earbuds") : t("Bluetooth Headphones") });
    const infoCol = h("div", { class: "accessory-dev-info" }, nameEl, kindEl);

    // Battery visualization
    const hasBuds = dev.leftBud != null || dev.rightBud != null;
    let batterySection: HTMLElement;

    if (hasBuds) {
      const leftLevel = dev.leftBud ?? dev.battery;
      const rightLevel = dev.rightBud ?? dev.battery;
      const caseLevel = dev.caseBattery;

      const leftCard = h(
        "div",
        { class: "bud-battery-card" },
        h("span", { class: "bud-tag", text: "L" }),
        h("span", { class: "bud-val", text: `${leftLevel}%` }),
        h("div", { class: "bud-bar-wrap" }, h("div", { class: "bud-bar-fill", style: `width: ${leftLevel}%; background: ${leftLevel <= 20 ? "#f87171" : "#38bdf8"};` })),
      );

      const rightCard = h(
        "div",
        { class: "bud-battery-card" },
        h("span", { class: "bud-tag", text: "R" }),
        h("span", { class: "bud-val", text: `${rightLevel}%` }),
        h("div", { class: "bud-bar-wrap" }, h("div", { class: "bud-bar-fill", style: `width: ${rightLevel}%; background: ${rightLevel <= 20 ? "#f87171" : "#38bdf8"};` })),
      );

      const caseCard = caseLevel != null ? h(
        "div",
        { class: "bud-battery-card case" },
        h("span", { class: "bud-tag", text: t("Case") }),
        h("span", { class: "bud-val", text: `${caseLevel}%` }),
        h("div", { class: "bud-bar-wrap" }, h("div", { class: "bud-bar-fill", style: `width: ${caseLevel}%; background: ${caseLevel <= 20 ? "#f87171" : "#34d399"};` })),
      ) : null;

      batterySection = h("div", { class: "buds-battery-grid" }, leftCard, rightCard, ...(caseCard ? [caseCard] : []));
    } else {
      const barFill = h("div", {
        class: "battery-bar-fill",
        style: `width: ${Math.min(100, Math.max(0, dev.battery))}%; background: ${bColor};`,
      });
      const barWrap = h("div", { class: "battery-bar-wrap" }, barFill);

      const levelText = h("span", { class: "battery-level-num", text: `${dev.battery}%` });
      const statusNote = h("span", {
        class: `battery-status-note ${isLow ? "low" : ""}`.trim(),
        text: isLow ? t("Low battery · Charge soon") : t("Battery level healthy"),
      });

      batterySection = h(
        "div",
        { class: "battery-single-wrap" },
        h("div", { class: "battery-num-row" }, levelText, statusNote),
        barWrap,
      );
    }

    // Actions row
    const btSettingsBtn = h(
      "button",
      {
        class: "accessory-action-btn",
        title: tl("Open Windows Bluetooth Settings"),
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          void Bridge.openUrl("ms-settings:bluetooth");
        },
      },
      h("span", { text: t("Bluetooth Settings") }),
    );

    const soundSettingsBtn = h(
      "button",
      {
        class: "accessory-action-btn",
        title: tl("Open Windows Sound Settings"),
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          void Bridge.openUrl("ms-settings:sound");
        },
      },
      h("span", { text: t("Sound Settings") }),
    );

    const actionsRow = h("div", { class: "accessory-actions-row" }, btSettingsBtn, soundSettingsBtn);

    return h("div", { class: "accessory-main-content" }, infoCol, batterySection, actionsRow);
  }

  function renderEmpty(): HTMLElement {
    const emptyIcon = h("div", { class: "accessory-empty-icon", text: "🎧" });
    const emptyTitle = h("div", { class: "accessory-empty-title", text: t("No Bluetooth audio connected") });
    const emptySub = h("div", { class: "accessory-empty-sub", text: t("Connect your Bluetooth headphones or earbuds in Windows Settings") });

    const openBtBtn = h(
      "button",
      {
        class: "accessory-action-btn primary",
        onclick: (e) => {
          e.stopPropagation();
          actions.blip();
          void Bridge.openUrl("ms-settings:bluetooth");
        },
      },
      h("span", { text: t("Open Bluetooth Settings") }),
    );

    return h("div", { class: "accessory-empty-wrap" }, emptyIcon, emptyTitle, emptySub, openBtBtn);
  }

  return {
    el,
    sync() {
      clear(contentContainer);
      const dev = State.activeAccessory || (State.accessoryDevices.length > 0 ? State.accessoryDevices[0] : null);
      if (dev && dev.connected) {
        statusBadge.textContent = t("Connected");
        statusBadge.className = "accessory-status-badge connected";
        contentContainer.append(renderConnected(dev));
      } else {
        statusBadge.textContent = t("Disconnected");
        statusBadge.className = "accessory-status-badge disconnected";
        contentContainer.append(renderEmpty());
      }
    },
  };
}
