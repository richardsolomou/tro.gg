import { BRAZIER_UPKEEP_RATE, BRAZIER_UPKEEP_TICK_MS, type ItemId } from "./constants";
import type { SkillId } from "./skills";

/**
 * Crafting (GDD "Crafting"): recipes turn shared-stockpile resources into
 * personal equipment at the Hearth's station. Every recipe carries the one
 * skill/level requirement that gates both crafting and wielding its output —
 * craft = wield, gated by the skill the item serves.
 */
export interface Recipe {
  output: ItemId;
  /** Bulk inputs, drawn from the shared stockpile — never a personal stack. */
  costs: { stone?: number; wood?: number };
  skill: SkillId;
  level: number;
}

/** The recipe registry (initial) — extend this table to add craftables.
 *  Level-1 recipes replace the Hearth's starter gear when it's lost; the
 *  fine tier is the tool ladder's first earned rung. */
export const RECIPES: readonly Recipe[] = [
  { output: "pickaxe", costs: { stone: 2, wood: 1 }, skill: "mining", level: 1 },
  { output: "fine_pickaxe", costs: { stone: 6, wood: 2 }, skill: "mining", level: 5 },
  { output: "axe", costs: { stone: 2, wood: 2 }, skill: "woodcutting", level: 1 },
  { output: "fine_axe", costs: { stone: 4, wood: 4 }, skill: "woodcutting", level: 5 },
  { output: "sword", costs: { stone: 3, wood: 2 }, skill: "combat", level: 1 },
  { output: "shield", costs: { stone: 1, wood: 4 }, skill: "combat", level: 1 },
  { output: "torch", costs: { wood: 2 }, skill: "woodcutting", level: 1 },
];

export function recipeFor(item: string): Recipe | undefined {
  return RECIPES.find((r) => r.output === item);
}

/** Craft = wield (GDD "Crafting"): tier gear demands the same level that
 *  crafted it, whoever's pack it ended up in. Level-1 recipes (and anything
 *  recipe-less) stay wieldable by everyone — starter gear never locks. */
export function wieldRequirement(item: string): { skill: SkillId; level: number } | undefined {
  const r = recipeFor(item);
  return r && r.level > 1 ? { skill: r.skill, level: r.level } : undefined;
}

/**
 * The fire eats first (GDD "The stockpile"): discretionary spending can never
 * draw the pool below this many hours of the tribe's current total brazier
 * upkeep. One hour *(initial)* — a day's upkeep for even one brazier
 * (2,880 wood) would exceed `STOCKPILE_CAP` and freeze crafting entirely,
 * so the reserve is sized to guarantee the next stretch, not the next day.
 */
export const STOCKPILE_UPKEEP_RESERVE_HOURS = 1;

/** The wood the reserve protects, given how many upkeep-billed (lit,
 *  non-eternal) braziers are burning right now. */
export function upkeepReserve(litUpkeepBraziers: number): number {
  const ticks = Math.ceil((STOCKPILE_UPKEEP_RESERVE_HOURS * 3_600_000) / BRAZIER_UPKEEP_TICK_MS);
  return Math.max(0, litUpkeepBraziers) * BRAZIER_UPKEEP_RATE * ticks;
}

/** A torch burns down while equipped (GDD "Crafting"): wear accrues on its
 *  inventory row each wander-sweep tick, and at this total the torch is
 *  spent — consumed, unequipped, gone. Pushing into the dark costs wood. (initial) */
export const TORCH_BURN_MS = 5 * 60_000;

/** The moving pocket of lit ground an equipped torch projects (GDD
 *  "Crafting"): dark creatures cannot enter it — the same cannot-cross rule
 *  a brazier enforces, at a personal radius. Euclidean tiles. (initial) */
export const TORCH_LIT_RADIUS = 2.5;
