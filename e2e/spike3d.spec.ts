import { expect, test } from "@playwright/test";

/**
 * Smoke-test for the full-3D spike (`/spike3d`): the scene boots and the WebGL canvas
 * paints a non-trivial number of non-sky pixels — the same "it still draws" check the
 * art preview uses, so a regression that blanks the page fails CI instead of slipping by.
 */

/** The spike's sky (`scene.background`, #bcd0e8); pixels within tolerance count as empty. */
const SKY = { r: 0xbc, g: 0xd0, b: 0xe8 };

test("the 3D spike renders a scene", async ({ page }) => {
  await page.goto("/spike3d");
  await page.waitForFunction(() => (window as unknown as { __spike3dReady?: boolean }).__spike3dReady === true);
  const painted = await page.evaluate((sky) => {
    const src = document.querySelector<HTMLCanvasElement>("canvas");
    if (!src) return 0;
    const off = document.createElement("canvas");
    off.width = src.width;
    off.height = src.height;
    const ctx = off.getContext("2d")!;
    ctx.drawImage(src, 0, 0);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const offSky = Math.abs(data[i] - sky.r) + Math.abs(data[i + 1] - sky.g) + Math.abs(data[i + 2] - sky.b);
      if (data[i + 3] > 8 && offSky > 24) count++;
    }
    return count;
  }, SKY);
  await test.info().attach("spike3d", { body: await page.locator("canvas").screenshot(), contentType: "image/png" });
  expect(painted, "canvas should render the ground and trogg, not just sky").toBeGreaterThan(5000);
});
