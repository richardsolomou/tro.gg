import type { DbConnection } from "./module_bindings";
import { POSTHOG_KEY } from "../env.js";

function telemetry(source: string): { posthogKey: string; source: string } {
  return { posthogKey: POSTHOG_KEY ?? "", source };
}

export function sendChat(conn: DbConnection, text: string) {
  return conn.procedures.chatAction({ text, ...telemetry("chat") });
}

export function spawnDebugEntity(conn: DbConnection, kind: "boulder" | "tree" | "item" | "dark_creature", item: string, source: string) {
  return conn.procedures.spawnAction({ kind, item, ...telemetry(source) });
}

export function craftItem(conn: DbConnection, item: string, source: string) {
  return conn.procedures.craftItemAction({ item, ...telemetry(source) });
}

export function resetBoulders(conn: DbConnection, source: string) {
  return conn.procedures.resetBouldersAction(telemetry(source));
}

export function resetDarkCreatures(conn: DbConnection, source: string) {
  return conn.procedures.resetDarkCreaturesAction(telemetry(source));
}

export function revealNextRegion(conn: DbConnection, source: string) {
  return conn.procedures.revealNextRegionAction(telemetry(source));
}

export function resetFrontier(conn: DbConnection, source: string) {
  return conn.procedures.resetFrontierAction(telemetry(source));
}

export function jumpRegions(conn: DbConnection, count: number, source: string) {
  return conn.procedures.jumpRegionsAction({ count, ...telemetry(source) });
}

export function hauntGhost(conn: DbConnection, count: number, source: string) {
  return conn.procedures.hauntGhostAction({ count, ...telemetry(source) });
}

export function renameTrogg(conn: DbConnection, name: string, source = "appearance") {
  return conn.procedures.renameAction({ name, ...telemetry(source) });
}

export function recolorTrogg(conn: DbConnection, color: number, source = "appearance") {
  return conn.procedures.recolorAction({ color, ...telemetry(source) });
}

export function restyleTrogg(conn: DbConnection, style: number, source = "appearance") {
  return conn.procedures.restyleAction({ style, ...telemetry(source) });
}

export function interact(conn: DbConnection, dirX: number, dirY: number, source = "keyboard") {
  return conn.procedures.interactAction({ dirX, dirY, ...telemetry(source) });
}

export function equipItem(conn: DbConnection, inventoryId: bigint, source = "inventory") {
  return conn.procedures.equipItemAction({ inventoryId, ...telemetry(source) });
}

export function dropItem(conn: DbConnection, inventoryId: bigint, source = "inventory") {
  return conn.procedures.dropItemAction({ inventoryId, ...telemetry(source) });
}

export function discardItem(conn: DbConnection, inventoryId: bigint, source = "inventory") {
  return conn.procedures.discardItemAction({ inventoryId, ...telemetry(source) });
}

export function useEquipped(conn: DbConnection, dirX: number, dirY: number, source = "keyboard") {
  return conn.procedures.useEquippedAction({ dirX, dirY, ...telemetry(source) });
}
