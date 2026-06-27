import { isFeatureEnabled } from "../analytics.js";
import { hudRoot } from "./hud.js";
import { currentCommandFlags } from "./chat_commands.js";

/** One control or command line: the key/command and what it does. */
interface Row {
  key: string;
  desc: string;
}

/** A titled block of rows in the help panel (Controls, Commands). */
interface Section {
  title: string;
  rows: Row[];
}

/**
 * The help panel as an HTML overlay: a top-left "? Help" toggle that opens a list
 * of controls and chat commands (GDD HUD note). The listed controls and commands
 * mirror the feature flags actually enabled this session, so the panel never
 * advertises a key or command that's switched off. Static reference, built once.
 */
export function mountHelp(): void {
  const root = document.createElement("div");
  root.className = "panel help";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "help-toggle";
  toggle.textContent = "? Help";

  const body = document.createElement("div");
  body.className = "help-body";
  body.hidden = true;

  for (const section of buildSections()) {
    const block = document.createElement("div");
    block.className = "help-section";
    const title = document.createElement("div");
    title.className = "help-section-title";
    title.textContent = section.title;
    const rows = document.createElement("div");
    rows.className = "help-rows";
    for (const row of section.rows) {
      const key = document.createElement("span");
      key.className = "help-key";
      key.textContent = row.key;
      const desc = document.createElement("span");
      desc.textContent = row.desc;
      rows.append(key, desc);
    }
    block.append(title, rows);
    body.appendChild(block);
  }

  toggle.addEventListener("click", () => {
    const opening = body.hidden;
    body.hidden = !opening;
    if (opening) window.dispatchEvent(new CustomEvent("hud-menu-open", { detail: "help" }));
  });
  window.addEventListener("hud-menu-open", ((event: Event) => {
    if ((event as CustomEvent<string>).detail !== "help") body.hidden = true;
  }) as EventListener);

  root.append(toggle, body);
  hudRoot().appendChild(root);
}

/** The controls and commands to show, filtered to this session's enabled flags. */
function buildSections(): Section[] {
  const canRun = isFeatureEnabled("running");
  const useInteract = isFeatureEnabled("interact");
  const pushEnabled = isFeatureEnabled("boulder-pushing");
  const chatEnabled = isFeatureEnabled("chat-enabled");
  const commandFlags = currentCommandFlags();

  const controls: Row[] = [
    { key: "WASD / Arrows", desc: "Move" },
    { key: "Click", desc: "Walk to a tile" },
  ];
  if (canRun) controls.push({ key: "Hold Shift", desc: "Run" });
  if (useInteract) controls.push({ key: "E", desc: "Pick up / put down" });
  if (pushEnabled) controls.push({ key: "Walk into a boulder", desc: "Push it" });
  if (chatEnabled) controls.push({ key: "Enter", desc: "Open chat" });

  const sections: Section[] = [{ title: "Controls", rows: controls }];

  // Commands are typed into the chat box, so they only matter when chat is on.
  if (chatEnabled) {
    const commands: Row[] = [];
    if (commandFlags.spawn) commands.push({ key: "/spawn boulder [count] | hedgehog [count]", desc: "Spawn objects" });
    const resetTargets = [commandFlags.resetBoulders && "boulders", commandFlags.resetHogs && "hedgehogs"].filter(Boolean);
    if (resetTargets.length) commands.push({ key: `/reset ${resetTargets.join(" | ")}`, desc: "Reset to the default layout" });
    if (commandFlags.ghost) commands.push({ key: "/ghost", desc: "Summon a ghost" });
    if (commands.length) sections.push({ title: "Commands", rows: commands });
  }

  return sections;
}
