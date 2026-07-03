export const TEXT_RESOLUTION = Math.min(window.devicePixelRatio || 1, 2);

/** CSS hex for a 0xRRGGBB colour, for DOM styling. */
export function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
