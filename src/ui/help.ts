import { isFeatureEnabled } from "../analytics.js";
import { currentCommandFlags } from "./chat_commands.js";

/** One control line: the key/control and what it does. */
interface Row {
  key: string;
  desc: string;
}

/**
 * The controls reference (GDD HUD note), rendered as a block of key → action
 * rows for the game menu's Help tab. The listed controls mirror the feature
 * flags actually enabled this session, so the panel never advertises a key
 * that's switched off.
 */
export function renderControls(): HTMLElement {
  const block = document.createElement("div");
  block.className = "menu-controls";
  for (const row of buildControls()) {
    const key = document.createElement("span");
    key.className = "help-key";
    key.textContent = row.key;
    const desc = document.createElement("span");
    desc.textContent = row.desc;
    block.append(key, desc);
  }
  return block;
}

/** The controls to show, filtered to this session's enabled flags. */
function buildControls(): Row[] {
  const canRun = isFeatureEnabled("running");
  const useInteract = isFeatureEnabled("interact");
  const chatEnabled = isFeatureEnabled("chat-enabled");
  const commandFlags = currentCommandFlags();
  const commandPanelEnabled = commandFlags.spawn || commandFlags.ghost;

  const controls: Row[] = [
    { key: "WASD / Arrows", desc: "Move" },
    { key: "Click", desc: "Walk to a tile" },
  ];
  if (canRun) controls.push({ key: "Hold Shift", desc: "Run" });
  if (useInteract) controls.push({ key: "E", desc: "Pick up / put down" });
  controls.push({ key: "F", desc: "Use equipped item" });
  controls.push({ key: "I / C / K / P", desc: "Pack · Crafting · Skills · Appearance" });
  controls.push({ key: "Sword + F", desc: "Attack a faced trogg" });
  controls.push({ key: "Carry + F", desc: "Throw held object" });
  controls.push({ key: "I", desc: "Inventory (right-click an item for actions)" });
  controls.push({ key: "P", desc: "Appearance" });
  controls.push({ key: "M", desc: "World map" });
  if (commandPanelEnabled) controls.push({ key: "`", desc: "Debug tools" });
  if (chatEnabled) controls.push({ key: "Enter", desc: "Chat" });
  controls.push({ key: "Esc", desc: "Open this menu / close what's open" });

  return controls;
}
