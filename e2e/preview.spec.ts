import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke-tests the art preview at a handful of URL-addressed states. Each asserts the WebGL
 * canvas paints a non-trivial number of non-background pixels — a deterministic "the rig still
 * draws" check that survives across machines (unlike a pixel snapshot), and attaches the
 * rendered frame to the report for human sign-off. Paused states give a stable frame to read.
 */

/** The preview's background (`#0a0806`); pixels within tolerance of it count as empty. */
const BG = { r: 0x0a, g: 0x08, b: 0x06 };

/** Wait for the first painted frame, then count canvas pixels that differ from the background.
 *  `preserveDrawingBuffer` (set on the preview's Phaser game) lets a 2D context read them back. */
async function nonBackgroundPixels(page: Page): Promise<number> {
  await page.waitForFunction(() => (window as unknown as { __previewReady?: boolean }).__previewReady === true);
  return page.evaluate((bg) => {
    const src = document.querySelector<HTMLCanvasElement>("#preview canvas");
    if (!src) return 0;
    const off = document.createElement("canvas");
    off.width = src.width;
    off.height = src.height;
    const ctx = off.getContext("2d")!;
    ctx.drawImage(src, 0, 0);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const off2bg = Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b);
      if (data[i + 3] > 8 && off2bg > 24) count++;
    }
    return count;
  }, BG);
}

const STATES = [
  { name: "trogg wielding sword + shield, mid-attack", query: "creature=trogg:moss&item=sword&off=shield&mode=attack&paused=1&scrub=0.35" },
  { name: "buff hog idle", query: "creature=hog:buff&item=none&mode=idle&paused=1" },
  { name: "trogg hit-flinch", query: "creature=trogg:moss&item=sword&mode=hit&paused=1&scrub=0.2" },
  { name: "item view: sword", query: "view=item&item=sword" },
  { name: "bones overlay", query: "creature=trogg:moss&item=pickaxe&mode=walk&paused=1&bones=1" },
];

for (const state of STATES) {
  test(`preview renders — ${state.name}`, async ({ page }) => {
    await page.goto(`/preview?${state.query}`);
    const painted = await nonBackgroundPixels(page);
    await test.info().attach("preview", { body: await page.locator("#preview canvas").screenshot(), contentType: "image/png" });
    expect(painted, "canvas should render a non-trivial creature/item").toBeGreaterThan(500);
  });
}

test("an unknown deep link still boots the default preview", async ({ page }) => {
  await page.goto("/preview?creature=bogus:nope&item=notathing&mode=spin");
  expect(await nonBackgroundPixels(page)).toBeGreaterThan(500);
});
