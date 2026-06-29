import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end harness for the dev art preview (`/preview`). It boots the Vite dev server,
 * loads URL-addressed preview states, and checks the WebGL canvas actually renders — so a
 * rig/art regression that blanks the preview fails here instead of being noticed by eye.
 * The preview is connectionless, so no SpacetimeDB module is needed.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Headless Chromium has no GPU, so force ANGLE's SwiftShader backend and allow the
        // unsafe-fallback flag recent Chromium requires, or Phaser's WebGL context won't init.
        launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
      },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173/preview",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
