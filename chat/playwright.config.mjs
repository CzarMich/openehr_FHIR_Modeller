import { defineConfig } from "@playwright/test";
export default defineConfig({
    testDir: "test",
    testMatch: "browser.spec.mjs",
    fullyParallel: false,
    workers: 1,
    timeout: 30000,
    use: {
        baseURL: "http://127.0.0.1:8359",
        viewport: { width: 1440, height: 1000 },
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    webServer: {
        command: "node test/fixture-server.mjs",
        url: "http://127.0.0.1:8359/health",
        reuseExistingServer: false,
    },
});
