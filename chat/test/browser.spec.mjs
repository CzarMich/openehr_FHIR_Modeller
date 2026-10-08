import { test, expect } from "@playwright/test";
import sharp from "sharp";
const imagePng = await sharp({ create: { width: 200, height: 120, channels: 3, background: "#005eb8" } })
    .png()
    .toBuffer();
const imageJpeg = await sharp(imagePng).jpeg().toBuffer();
let browserErrors;
test.beforeEach(async ({ page }) => {
    browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
});

test("administrator accounts workspace is role-gated and usable on mobile", async ({ page }) => {
    await page.route("**/chat/api/session", async (route) =>
        route.fulfill({
            json: {
                enabled: false,
                authenticated: true,
                user: { id: "owner-id", name: "Workspace Owner", roles: ["modelling-administrator"] },
                csrf: "fixture-csrf",
                reviewEnabled: true,
                identityEnabled: true,
                identitySetupRequired: false,
                oidcEnabled: false,
            },
        }),
    );
    await page.route("**/chat/api/identity/users", async (route) =>
        route.fulfill({ json: { users: [], serviceAccounts: [], audit: { events: [] } } }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat/");
    await page.getByRole("tab", { name: "Accounts" }).click();
    await expect(page.getByRole("heading", { name: "Accounts and access" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invite a user" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Service credential", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test.afterEach(async () => {
    expect(browserErrors).toEqual([]);
});
async function login(page) {
    await page.goto("/chat/");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#oidc-login").click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}
async function settings(page, open = true) {
    const dialog = page.locator("#chat-settings-dialog");
    if (open && !(await dialog.isVisible()))
        await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    if (!open && (await dialog.isVisible()))
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
}
async function send(page, message) {
    await settings(page, false);
    await settings(page, false);
    await page.getByRole("textbox", { name: "Message the modelling assistant" }).fill(message);
    const response = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/messages"),
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    expect((await response).status()).toBe(200);
}
async function addRepository(page) {
    await settings(page);
    await page.locator("#personal-settings > summary").click();
    await page.getByLabel("Connection type").selectOption("github");
    await page.getByLabel("Connection name", { exact: true }).fill("My models");
    await page.getByLabel("HTTPS URL", { exact: true }).fill("https://github.com/example/personal-models");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove My models" })).toBeVisible();
    await settings(page);
    await page.locator("#personal-settings > summary").click();
}

test("Copilot Studio can be connected, checked and selected from the browser with in-app setup help", async ({
    page,
}) => {
    let connected = false,
        signingIn = false,
        received;
    await page.route("**/chat/api/session", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        if (data.authenticated)
            data.providers = [
                { id: "codex", name: "Codex", connected: true },
                { id: "claude", name: "Claude", connected: false },
                { id: "copilot", name: "Copilot Studio", connected, signingIn },
            ];
        await route.fulfill({ response, json: data });
    });
    await page.route("**/chat/api/providers/copilot", async (route) => {
        if (route.request().method() === "DELETE") {
            connected = false;
            signingIn = false;
            return route.fulfill({ json: { success: true } });
        }
        received = route.request().postDataJSON();
        signingIn = true;
        await route.fulfill({ json: { verificationUrl: "https://microsoft.com/devicelogin", userCode: "TEST-CODE" } });
    });
    await page.route("**/chat/api/providers/copilot/test", (route) =>
        route.fulfill({
            json: {
                verified: true,
                message: "Published agent and workspace tools verified. No patient data was accessed.",
            },
        }),
    );
    await login(page);
    await settings(page);
    await page.locator("#provider-settings > summary").click();
    await page.locator("#chat-provider").selectOption("copilot");
    await page.locator("#copilot-tenant").fill("11111111-1111-1111-1111-111111111111");
    await page.locator("#copilot-client").fill("22222222-2222-2222-2222-222222222222");
    await page.locator("#copilot-environment").fill("33333333-3333-3333-3333-333333333333");
    await page.locator("#copilot-schema").fill("cr123_Modelling");
    await page.locator("#connect-copilot").click();
    await expect(page.locator("#copilot-device")).toBeVisible();
    await expect(page.locator("#copilot-code")).toHaveText("TEST-CODE");
    expect(received.schemaName).toBe("cr123_Modelling");
    connected = true;
    signingIn = false;
    await expect(page.locator("#copilot-status")).toHaveText("Connected", { timeout: 10000 });
    await page.locator("#test-copilot").click();
    await expect(page.locator("#copilot-test-status")).toContainText("workspace tools verified");
    await send(page, "List the available CKM sources");
    await expect(page.locator("#chat-provider")).toHaveValue("copilot");
    await settings(page);
    await page.locator("#disconnect-copilot").click();
    await expect(page.locator("#copilot-status")).toHaveText("Not connected");
    await settings(page, false);
    await page.goto("/chat/#help-copilot-browser");
    await expect(page.getByRole("heading", { name: "Use Copilot Studio in this browser" })).toBeVisible();
    await expect(page.locator("#copilot-tool-definition")).toHaveValue(/System.ClientPluginActions/);
    await expect(page.locator("#copilot-agent-instructions")).toHaveValue(/Never fetch CDR patient records/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await settings(page);
    await expect(page.locator("#copilot-connection")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settings(page, false);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator("#copilot-tenant")).toHaveValue("");
    await expect(page.locator("#copilot-code")).toHaveText("");
});

test("repository selection must finish saving before the assistant can receive a message", async ({ page }) => {
    await login(page);
    await send(page, "Start a modelling conversation");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await addRepository(page);
    let releaseSelection;
    const waiting = new Promise((resolve) => (releaseSelection = resolve));
    await page.route("**/settings", async (route) => {
        await waiting;
        await route.continue();
    });
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await settings(page, false);
    await page.getByRole("textbox", { name: "Message the modelling assistant" }).fill("inspect repository");
    await settings(page);
    await expect(page.locator("#save-destination-status")).toContainText("Not active yet");
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    try {
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeDisabled();
        await expect(page.locator("#save-destination-status")).toContainText("Saving repository choice");
    } finally {
        releaseSelection();
    }
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await send(page, "inspect repository");
    await expect(page.locator(".message.assistant").last()).toContainText(
        "Save destination: https://github.com/example/personal-models · main. Personal save available.",
    );
});

test("a new chat saves its repository with creation before uploading or sending", async ({ page }) => {
    await login(page);
    await addRepository(page);
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    const repository = await page.getByLabel("Save artifacts to").inputValue();
    const created = page.waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith("/conversations"),
    );
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    expect((await created).postDataJSON().repository).toBe(repository);
    await expect(page.locator("#save-destination-status")).toContainText("Active:");
    await page.getByLabel("Attach files", { exact: true }).setInputFiles({
        name: "requirements.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("concept\ncreatinine\n"),
    });
    await expect(page.locator("#attachment-list")).toContainText("Text ready");
    await send(page, "inspect repository");
    await expect(page.locator(".message.assistant").last()).toContainText(
        "Save destination: https://github.com/example/personal-models · main. Personal save available.",
    );
    await page.reload();
    await page.getByRole("button", { name: "inspect repository", exact: true }).click();
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(repository);
    await expect(page.locator("#save-destination-status")).toContainText("https://github.com/example/personal-models");
});

test("a repository changed in another tab preserves the unsent instructions and refreshes the destination", async ({
    page,
}) => {
    await login(page);
    await addRepository(page);
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    await expect(page.locator("#save-destination-status")).toContainText("Active:");
    await send(page, "inspect repository");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    const session = await (await page.request.get("/chat/api/session")).json();
    const { conversations } = await (await page.request.get("/chat/api/conversations")).json();
    const changed = await page.request.put("/chat/api/conversations/" + conversations[0].id + "/settings", {
        headers: { Origin: "http://127.0.0.1:8359", "X-CSRF-Token": session.csrf },
        data: { repository: null },
    });
    expect(changed.status()).toBe(200);
    await settings(page, false);
    await page.getByRole("textbox", { name: "Message the modelling assistant" }).fill("Save my reviewed AKI drafts");
    const response = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/messages"),
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    expect((await response).status()).toBe(409);
    await expect(page.getByRole("alert")).toContainText("repository choice changed");
    await expect(page.getByLabel("Save artifacts to")).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "Message the modelling assistant" })).toHaveValue(
        "Save my reviewed AKI drafts",
    );
    await expect(page.locator(".message.user")).toHaveCount(1);
});

test("personal CKMs and repository destinations persist, while enterprise duplicates are ignored", async ({ page }) => {
    await login(page);
    await settings(page);
    await page.locator("#personal-settings > summary").click();
    await page.getByLabel("Connection name", { exact: true }).fill("Already provided");
    await page.getByLabel("HTTPS URL", { exact: true }).fill("https://ckm.example.org/ckm/rest/");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("No duplicate was added");
    await expect(page.getByRole("button", { name: "Remove Already provided" })).toHaveCount(0);
    await page.getByLabel("Connection type").selectOption("github");
    await page.getByLabel("Connection name", { exact: true }).fill("Personal models");
    await page.getByLabel("HTTPS URL", { exact: true }).fill("https://github.com/example/personal-models");
    await page.getByLabel("Target branch", { exact: true }).fill("drafts");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove Personal models" })).toBeVisible();
    await settings(page);
    await page.locator("#personal-settings > summary").click();
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "Personal models · drafts" });
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    await expect(page.locator("#save-destination-status")).toContainText("Active:");
    await send(page, "Use my personal repository");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await page.reload();
    await page.getByRole("button", { name: "Use my personal repository", exact: true }).click();
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(/^[a-f0-9-]{36}$/);
});

test("CKM discovery errors stay inside source settings and can be retried", async ({ page }) => {
    let unavailable = true;
    await page.route("**/api/connections", (route) =>
        route.fulfill({
            json: {
                enterprise: unavailable
                    ? []
                    : [
                          {
                              id: "default",
                              label: "Default CKM",
                              kind: "ckm",
                              scope: "enterprise",
                              url: "https://ckm.example/rest/",
                          },
                      ],
                personal: [],
                enterpriseUnavailable: unavailable,
            },
        }),
    );
    const initialConnections = page.waitForResponse("**/api/connections");
    await login(page);
    await initialConnections;
    await expect(page.locator("#enterprise-ckm-status")).toBeHidden();
    await expect(page.getByRole("alert")).toBeHidden();
    const settingsConnections = page.waitForResponse("**/api/connections");
    await settings(page);
    await page.locator("#personal-settings > summary").click();
    await settingsConnections;
    await expect(page.locator("#enterprise-ckm-status")).toBeVisible();
    unavailable = false;
    await page.getByRole("button", { name: "Retry CKM sources", exact: true }).click();
    await expect(page.locator("#enterprise-ckm-status")).toBeHidden();
    await expect(page.locator("#connection-list")).toContainText("Default CKM");
});

test("an existing repository can gain a token without losing its selected identity", async ({ page }) => {
    await login(page);
    await addRepository(page);
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    await expect(page.locator("#save-destination-status")).toContainText("Active:");
    const repository = await page.getByLabel("Save artifacts to").inputValue();
    await expect(page.locator("#repository-token-status")).toContainText("Read-only");
    await settings(page);
    await page.locator("#personal-settings > summary").click();
    await page.getByRole("button", { name: "Update access for My models", exact: true }).click();
    await page.getByLabel("Personal access token (optional for public reads)").fill("synthetic-browser-token");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Repository access updated");
    await expect(page.getByLabel("Personal access token (optional for public reads)")).toHaveValue("");
    await expect(page.locator("#repository-token-status")).toBeHidden();
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(repository);
    await expect(page.locator("#connection-list")).not.toContainText("synthetic-browser-token");
});

test("upload source files, create a read-only snapshot and revoke its link", async ({ page, context }) => {
    await login(page);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles({
        name: "renal.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("requirement,unit\nurine volume,mL\n"),
    });
    await expect(page.locator("#attachment-list")).toContainText("ready");
    await expect(page.getByRole("link", { name: "renal.csv", exact: true })).toBeVisible();
    await send(page, "Model the source requirements");
    await expect(page.getByRole("button", { name: "Share chat", exact: true })).toBeEnabled();
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await page.getByRole("button", { name: "Share chat", exact: true }).click();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect(page.getByLabel("Share link", { exact: true })).toHaveValue(/#share=/);
    const link = await page.getByLabel("Share link", { exact: true }).inputValue();
    const viewer = await context.newPage();
    await viewer.goto(link);
    await expect(viewer.getByRole("alert")).toContainText("Shared snapshot");
    await expect(viewer.getByRole("textbox", { name: "Message the modelling assistant" })).toBeDisabled();
    await expect(viewer.locator("#attachment-list")).toBeEmpty();
    await expect(viewer.locator(".message.user")).toContainText("Participant");
    await page.getByRole("button", { name: "Revoke link", exact: true }).click();
    await expect(page.locator("#share-status")).toHaveText("Link revoked.");
    await viewer.reload();
    await expect(viewer.getByRole("alert")).toContainText("not found or expired");
    await viewer.close();
});

test("sign in, tool-backed chat, code rendering, history and sign out", async ({ page }) => {
    await login(page);
    await send(page, "Which CKMs are configured?");
    await expect(page.locator(".message.assistant")).toContainText("Terminology binding is optional.");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await expect(page.locator(".tool-chip")).toContainText("CKM sources");
    await expect(page.locator(".message-content strong")).toHaveText("default");
    await expect(page.locator("pre code")).toContainText("<draft/>");
    await page.reload();
    await page
        .getByRole("navigation", { name: "Your conversations" })
        .getByRole("button", { name: "Which CKMs are configured?", exact: true })
        .click();
    await expect(page.locator(".message.assistant")).toContainText("default");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator(".message")).toHaveCount(0);
});

test("model writes wait for an explicit browser confirmation", async ({ page }) => {
    await login(page);
    await send(page, "save");
    await expect(page.getByRole("heading", { name: "Save draft" })).toBeVisible();
    await expect(page.locator(".approval pre")).toContainText("revision-one");
    await page.getByRole("button", { name: "Confirm save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await expect(page.locator(".message.assistant")).toContainText("saved after your confirmation");
});

test("stopping a turn allows another message", async ({ page }) => {
    await login(page);
    await send(page, "wait");
    await expect(page.locator("#chat-form")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#activity")).toHaveAttribute("data-working", "true");
    expect(await page.locator("#activity").evaluate((node) => getComputedStyle(node, "::before").animationName)).toBe(
        "working-ring",
    );
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop response", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await expect(page.locator(".message.assistant")).toContainText("Response stopped");
    await expect(page.locator("#chat-form")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activity")).toBeEmpty();
    await send(page, "Which sources?");
    await expect(page.locator(".message.assistant").last()).toContainText("default");
});

test("mobile layout and untrusted markup remain safe", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await send(page, '<img src=x onerror="window.__executed=true"> [unsafe](javascript:alert(1))');
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await expect(page.locator(".message.user")).toContainText("<img");
    expect(await page.evaluate(() => window.__executed)).toBeUndefined();
    await expect(page.locator(".message img")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Toggle conversations", exact: true }).click();
    await expect(page.locator("#new-chat")).toBeVisible();
});

test("hosted draft reviews require an explicit review confirmation", async ({ page }) => {
    await login(page);
    await send(page, "review");
    await expect(page.getByRole("button", { name: "Confirm review request", exact: true })).toBeVisible();
    await expect(page.locator(".approval")).toContainText("draft/model");
    await page.getByRole("button", { name: "Confirm review request", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText(
        "draft review was requested after your confirmation",
    );
});

test("terminology saves present the exact version and revision for confirmation", async ({ page }) => {
    await login(page);
    await send(page, "terminology");
    await expect(page.getByRole("heading", { name: "Save draft terminology" })).toBeVisible();
    await expect(page.locator(".approval pre")).toContainText("terminology-revision");
    await expect(page.locator(".approval pre")).toContainText("https://example.org/sets/feeding");
    await page.getByRole("button", { name: "Confirm save", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("saved after your confirmation");
});

test("binding plan confirmation includes both source and plan revisions", async ({ page }) => {
    await login(page);
    await send(page, "bindings");
    await expect(page.getByRole("heading", { name: "Save draft binding plan" })).toBeVisible();
    await expect(page.locator(".approval pre")).toContainText("source-revision");
    await expect(page.locator(".approval pre")).toContainText("plan-revision");
    await page.getByRole("button", { name: "Confirm save", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("saved after your confirmation");
});

test("human review shows exact evidence, confirms the decision, and blocks incomplete approval", async ({ page }) => {
    await login(page);
    await page.goto("/chat/reviews");
    await expect(page.locator("#review-signed-in-user")).toContainText("Signed in as");
    await page.getByRole("button", { name: "templates/review.oet · REVIEW_REQUESTED" }).click();
    await expect(page.locator("#review-identity")).toContainText("source-review-revision");
    await expect(page.locator("#review-validation-status")).toContainText("approval and publication are blocked");
    await expect(page.locator("#review-source")).toContainText("<script>");
    expect(await page.evaluate(() => window.__reviewInjected)).toBeUndefined();
    await expect(page.getByRole("option", { name: "Approve exact revision" })).toHaveCount(0);
    await page.getByLabel("Review comment").fill("Reviewed the exact synthetic revision; technical gates remain open.");
    await page.getByRole("button", { name: "Review decision", exact: true }).click();
    await expect(page.getByRole("region", { name: "Confirm model decision" })).toBeVisible();
    await expect(page.locator("#review-confirmation-details")).toContainText("source-review-revision");
    await expect(page.locator("#review-confirmation-details")).toContainText('"expectedSequence": 3');
    await expect(page.locator("#review-state")).toHaveText("REVIEW_REQUESTED");
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(page.locator("#review-state")).toHaveText("REVIEWED");
    await expect(page.locator("#review-notice")).toContainText("recorded for the displayed revision");
    await expect(page.getByRole("button", { name: "Review decision", exact: true })).toBeDisabled();
});

test("review workspace fits mobile and cancellation does not submit a decision", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat/reviews");
    await page.getByRole("button", { name: "templates/review.oet · REVIEW_REQUESTED" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Review comment").fill("Do not submit this decision.");
    await page.getByRole("button", { name: "Review decision", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("region", { name: "Confirm model decision" })).toBeHidden();
    await expect(page.locator("#review-state")).toHaveText("REVIEW_REQUESTED");
});

test("requirements graph writes require exact graph and revision confirmation", async ({ page }) => {
    await login(page);
    await send(page, "traceability");
    await expect(page.getByRole("heading", { name: "Save requirements traceability" })).toBeVisible();
    await expect(page.locator(".approval pre")).toContainText("R-023");
    await expect(page.locator(".approval pre")).toContainText("graph-revision");
    await page.getByRole("button", { name: "Confirm save", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("saved after your confirmation");
});

test("one workspace preserves chat and exact model context across tabs", async ({ page, context }) => {
    await login(page);
    await expect(page.locator(".context-badge")).toHaveCount(0);
    await expect(page.locator("#section-title")).toHaveText("Clinical modelling");
    await send(page, "Which CKMs are configured?");
    await expect(page.locator(".message.assistant")).toContainText("Terminology binding is optional.");
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await page.getByRole("button", { name: /admission.oet/ }).click();
    await expect(page.locator("#model-source")).toContainText("<script>");
    expect(await page.evaluate(() => window.__modelInjected)).toBeUndefined();
    await expect(page.locator("#model-revision")).toContainText("d".repeat(40));
    await page.getByRole("button", { name: "Discuss in chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message the modelling assistant" })).toHaveValue(
        /admission.oet.*exact revision/,
    );
    await expect(page.locator(".message.assistant")).toContainText("Terminology binding is optional.");
    await page.getByRole("tab", { name: "Governance", exact: true }).click();
    await expect(page.locator("#review-signed-in-user")).toContainText("Test Modeller");
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await expect(page.locator("#model-source")).toContainText("<template>");
    expect(context.pages()).toHaveLength(1);
    await page.screenshot({ path: "test-results/unified-workspace-desktop.png", fullPage: true });
});

test("original binary source downloads with exact bytes and stays in the workspace", async ({ page, context }) => {
    await login(page);
    const bytes = Buffer.from([0x50, 0x4b, 0, 0xff]),
        artifact = {
            path: "originals/" + "a".repeat(64) + "/Original ü.zip",
            revision: "b".repeat(40),
            sha256: "c".repeat(64),
            content: null,
            content_base64: bytes.toString("base64"),
            content_encoding: "base64",
            size_bytes: bytes.length,
            metadata: { kind: "original_source" },
            status: "DRAFT",
        };
    await page.route("**/chat/api/models/project?*", (route) =>
        route.fulfill({ json: { project: { id: "default" }, artifacts: [artifact] } }),
    );
    await page.route("**/chat/api/models/artifact?*", (route) => route.fulfill({ json: artifact }));
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await page.getByRole("button", { name: /Original ü.zip/ }).click();
    await expect(page.locator("#model-source")).toContainText("Original binary file · 4 bytes");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download source", exact: true }).click();
    const download = await downloadPromise,
        stream = await download.createReadStream(),
        chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(download.suggestedFilename()).toBe("Original ü.zip");
    expect(context.pages()).toHaveLength(1);
});

test("workspace tabs support keyboard navigation and fit a narrow viewport", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Chat", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Models", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: /admission.oet/ }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Filter models").fill("no-match");
    await expect(page.locator("#model-list")).toContainText("No models match");
    await page.getByRole("tab", { name: "Governance", exact: true }).click();
    await expect(page.locator("#review-project")).toHaveValue("default");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/unified-workspace-mobile.png", fullPage: true });
});

test("repository outage has a recoverable error and keeps navigation available", async ({ page }) => {
    await login(page);
    await page.route("**/chat/api/models/projects", (route) =>
        route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Repository is temporarily unavailable." }),
        }),
    );
    await page.getByRole("tab", { name: "Models", exact: true }).click();
    await expect(page.locator("#model-notice")).toContainText("temporarily unavailable");
    await expect(page.getByRole("button", { name: "Refresh projects" })).toBeEnabled();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message the modelling assistant" })).toBeEnabled();
});

test("help is available before sign-in and topic links survive reload on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat/#help-files");
    await expect(page.getByRole("tab", { name: "Help", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "2. Upload documents" })).toBeFocused();
    await expect(page.locator("#panel-help")).toContainText("10 files");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "2. Upload documents" })).toBeFocused();
    await page.getByRole("tab", { name: "Help", exact: true }).click();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Governance", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Help", exact: true })).toBeFocused();
});

test("contextual help stays in the workspace and preserves a draft message", async ({ page }) => {
    await login(page);
    await settings(page, false);
    await page.locator("#message").fill("Review the requirements in my publication");
    await page.getByRole("link", { name: "Help with uploads", exact: true }).click();
    await expect(page.getByRole("heading", { name: "2. Upload documents" })).toBeFocused();
    await page.getByRole("link", { name: "Add sources and repositories", exact: true }).click();
    await expect(page.getByRole("heading", { name: "3. Add sources and repositories" })).toBeFocused();
    await page.getByRole("link", { name: "Return to Chat", exact: true }).click();
    await expect(page.locator("#message")).toHaveValue("Review the requirements in my publication");
    await expect(page.getByRole("link", { name: "User guide", exact: true })).toHaveAttribute("href", "#help");
});

test("workspace has no detected WCAG AA accessibility violations in its primary views", async ({ page }) => {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    await login(page);
    for (const name of ["Chat", "Models", "Governance", "Help"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        if (name === "Models") await page.getByRole("button", { name: /admission.oet/ }).click();
        if (name === "Governance")
            await page.getByRole("button", { name: "templates/review.oet · REVIEW_REQUESTED" }).click();
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        expect(
            result.violations.map(({ id, description, nodes }) => ({
                id,
                description,
                targets: nodes.map((n) => n.target),
            })),
        ).toEqual([]);
    }
});

test("saved compilation confirms exact template and dependency revisions", async ({ page }) => {
    await login(page);
    await send(page, "compile");
    await expect(page.getByRole("heading", { name: "Compile and save OPT draft" })).toBeVisible();
    await expect(page.locator(".approval pre")).toContainText("template-revision");
    await expect(page.locator(".approval pre")).toContainText("dependency-revision");
    await expect(page.locator(".approval pre")).toContainText("openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0");
    await expect(page.locator(".message.assistant")).not.toContainText("saved after your confirmation");
    await page.getByRole("button", { name: "Confirm save", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("saved after your confirmation");
});

test("provider choice is retained per conversation and connection controls explain personal accounts", async ({
    page,
}) => {
    await page.goto("/chat/");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#oidc-login").click();
    await settings(page);
    await page.locator("#chat-provider").selectOption("claude");
    await settings(page, false);
    await page.locator("#message").fill("List sources");
    await settings(page, false);
    await page.locator("#send").click();
    await expect(page.locator("#thread")).toContainText("configured source");
    await expect(page.locator("#chat-provider")).toBeDisabled();
    await expect(page.locator("#chat-provider")).toHaveValue("claude");
    await settings(page);
    await page.locator("#provider-settings > summary").click();
    await expect(page.locator("#claude-connection")).toContainText("billed separately from a Claude subscription");
    await settings(page, false);
    await page.locator("#new-chat").click();
    await expect(page.locator("#chat-provider")).toBeEnabled();
    await settings(page);
    await page.locator("#chat-provider").selectOption("codex");
    await settings(page, false);
    await page.locator("#conversations button", { hasText: "List sources" }).click();
    await expect(page.locator("#chat-provider")).toHaveValue("claude");
});

test("disconnected users connect a personal Claude key before chatting", async ({ page }) => {
    let connected = false;
    await page.route("**/chat/api/session", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.providers = [
            { id: "codex", name: "Codex", connected: false },
            { id: "claude", name: "Claude", connected },
        ];
        await route.fulfill({ response, json: data });
    });
    await page.route("**/chat/api/providers/claude", async (route) => {
        if (route.request().method() === "POST") {
            expect(route.request().postDataJSON().apiKey).toBe("sk-ant-browser-fixture");
            connected = true;
        } else connected = false;
        await route.fulfill({ json: { success: true } });
    });
    await page.goto("/chat/");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#oidc-login").click();
    await settings(page);
    await page.locator("#chat-provider").selectOption("claude");
    await settings(page, false);
    await page.locator("#message").fill("List sources");
    await expect(page.locator("#send")).toBeDisabled();
    await settings(page);
    await page.locator("#provider-settings > summary").click();
    await page.locator("#claude-key").fill("sk-ant-browser-fixture");
    await page.locator("#connect-claude").click();
    await expect(page.locator("#claude-key")).toHaveValue("");
    await expect(page.locator("#claude-status")).toHaveText("Connected");
    await expect(page.locator("#send")).toBeEnabled();
    await page.locator("#disconnect-claude").click();
    await expect(page.locator("#claude-status")).toHaveText("Not connected");
    await expect(page.locator("#send")).toBeDisabled();
});

test("composer attachment icon opens the picker and keeps the draft editable during upload", async ({ page }) => {
    await login(page);
    await settings(page, false);
    await page.locator("#message").fill("Start my instructions");
    let releaseUpload;
    const gate = new Promise((resolve) => {
        releaseUpload = resolve;
    });
    await page.route("**/attachments", async (route) => {
        await gate;
        await route.continue();
    });
    const picker = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add files and images", exact: true }).click();
    await (await picker).setFiles({ name: "notes.png", mimeType: "image/png", buffer: imagePng });
    await expect(page.locator("#attachment-list")).toContainText("Uploading");
    await expect(page.locator("#message")).toBeEnabled();
    await settings(page, false);
    await page.locator("#message").fill("Finish my instructions while the file uploads");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    releaseUpload();
    await expect(page.locator("#attachment-list")).toContainText("Image ready");
    await expect(page.locator("#message")).toHaveValue("Finish my instructions while the file uploads");
    await page.getByRole("button", { name: "Preview notes.png", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "notes.png", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Preview of notes.png", exact: true })).toBeVisible();
    await expect
        .poll(() => page.locator("#attachment-preview-image").evaluate((image) => image.naturalWidth))
        .toBe(200);
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("button", { name: "Remove notes.png", exact: true }).click();
    await expect(page.locator("#attachment-list .attachment-card")).toHaveCount(0);
});

test("image cards follow sent messages, survive reload and remain available to later turns", async ({ page }) => {
    await login(page);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles([
        { name: "note.png", mimeType: "image/png", buffer: imagePng },
        { name: "chart.jpg", mimeType: "image/jpeg", buffer: imageJpeg },
    ]);
    await expect(page.locator("#upload-status")).toContainText("2 files added");
    await send(page, "inspect images");
    await expect(page.locator(".message.assistant")).toContainText("Image inputs: 2");
    await expect(page.locator("#attachment-list .attachment-card")).toHaveCount(0);
    await expect(page.locator(".message.user .attachment-card")).toHaveCount(2);
    await page.reload();
    await page.getByRole("button", { name: "inspect images", exact: true }).click();
    await expect(page.locator(".message.user .attachment-card")).toHaveCount(2);
    await page.locator("#conversation-files-title").click();
    await page.getByRole("button", { name: "Remove chart.jpg", exact: true }).click();
    await expect(page.locator("#conversation-file-list .attachment-card")).toHaveCount(1);
    await send(page, "inspect images");
    await expect(page.locator(".message.assistant").last()).toContainText("Image inputs: 1");
    await expect(page.locator(".message.user").last().locator(".attachment-card")).toHaveCount(0);
});

test("files can be dropped and images pasted into the composer without losing typed instructions", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await settings(page, false);
    await page.locator("#message").fill("Keep my clinical modelling instructions");
    await page.locator("#chat-form").evaluate((form) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(["concept,unit\nvolume,mL"], "evidence.csv", { type: "text/csv" }));
        form.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    await expect(page.locator("#attachment-list")).toContainText("Text ready");
    await page.locator("#message").evaluate((textarea, base64) => {
        const clipboardData = new DataTransfer();
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        clipboardData.items.add(new File([bytes], "pasted-note.png", { type: "image/png" }));
        textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, imagePng.toString("base64"));
    await expect(page.locator("#attachment-list")).toContainText("Image ready");
    await expect(page.locator("#message")).toHaveValue("Keep my clinical modelling instructions");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "Add files and images", exact: true })).toBeInViewport();
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
});

test("a malformed image reports its limitation and a later valid file still uploads", async ({ page }) => {
    await login(page);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles([
        { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
        { name: "valid.jpg", mimeType: "image/jpeg", buffer: imageJpeg },
    ]);
    await expect(page.locator("#upload-status")).toContainText("2 files added");
    await expect(page.locator("#attachment-list")).toContainText("Needs attention");
    await expect(page.locator("#attachment-list")).toContainText("Image ready");
    await expect(page.getByRole("button", { name: "Preview broken.png" })).toHaveCount(0);
    await page.getByRole("button", { name: "Remove broken.png", exact: true }).click();
    await expect(page.locator("#attachment-list .attachment-card")).toHaveCount(1);
});

test("single-click decisions pause the assistant and persist the selected answer", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await send(page, "choose intended use");
    const card = page.getByRole("group", { name: "What is the intended use?" });
    await expect(card).toBeVisible();
    expect(await page.locator("#thread").evaluate((node) => node.clientHeight)).toBeGreaterThan(180);
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    await expect(page.getByLabel("Save artifacts to")).toBeVisible();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(page.getByLabel("Save artifacts to")).toBeHidden();
    await expect(page.locator("#activity")).toHaveAttribute("data-waiting", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await card.getByRole("button", { name: "Clinical documentation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await expect(page.locator(".message.assistant")).toContainText("Modelling for: Clinical documentation");
    await expect(page.locator(".message.user").last()).toContainText("My choice");
    await page.reload();
    await page.getByRole("button", { name: "Toggle conversations" }).click();
    await page.getByRole("button", { name: "choose intended use", exact: true }).click();
    await expect(page.locator(".message.user").last()).toContainText("Clinical documentation");
});

test("multiple decisions support checkboxes, custom answers and skipping", async ({ page }) => {
    await login(page);
    await send(page, "choose multiple");
    let card = page.getByRole("group", { name: "What is the intended use?" });
    await card.getByRole("checkbox", { name: "Clinical documentation" }).check();
    await card.getByRole("checkbox", { name: "AKI detection/staging" }).check();
    await card.getByText("Write another answer", { exact: true }).click();
    await card.getByRole("textbox", { name: "Your own answer" }).fill("For adults only");
    await card.getByRole("button", { name: "Use selected options" }).click();
    await expect(page.locator(".message.assistant").last()).toContainText(
        "Clinical documentation; AKI detection/staging; For adults only",
    );
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await send(page, "choose intended use");
    card = page.getByRole("group", { name: "What is the intended use?" });
    await card.getByRole("button", { name: "Skip question" }).click();
    await expect(page.locator(".message.assistant").last()).toContainText("The question was skipped");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await send(page, "choose intended use");
    card = page.getByRole("group", { name: "What is the intended use?" });
    await card.getByText("Write another answer", { exact: true }).click();
    await card.getByRole("textbox", { name: "Your own answer" }).fill("Education");
    await card.getByRole("button", { name: "Use my answer" }).click();
    await expect(page.locator(".message.assistant").last()).toContainText("Modelling for: Education");
});

test("two PDFs and an Excel workbook upload together and reach the modelling tools", async ({ page }) => {
    const { sourcePdf } = await import("./fixtures/pdf.mjs");
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Requirement"], ["Urine volume"]]), "Evidence");
    await login(page);
    await page.getByLabel("Attach files", { exact: true }).setInputFiles([
        { name: "publication.pdf", mimeType: "application/pdf", buffer: sourcePdf() },
        {
            name: "guidance.PDF",
            mimeType: "application/pdf",
            buffer: Buffer.concat([Buffer.from("\ufeff"), sourcePdf()]),
        },
        {
            name: "requirements.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
        },
    ]);
    await expect(page.locator("#upload-status")).toContainText("3 files added");
    await expect(page.locator("#attachment-list .attachment-card")).toHaveCount(3);
    await expect(page.locator("#attachment-list")).not.toContainText("Needs attention");
    await send(page, "inspect sources");
    await expect(page.locator(".message.assistant")).toContainText(
        "publication.pdf: [Page 1] Renal publication evidence",
    );
    await expect(page.locator(".message.assistant")).toContainText("guidance.PDF: [Page 1] Renal publication evidence");
    await expect(page.locator(".message.assistant")).toContainText("Urine volume");
});

test("empty and non-JSON upload failures show actionable messages and preserve the draft", async ({ page }) => {
    await login(page);
    await page.locator("#message").fill("Keep these clinical modelling instructions");
    const cases = [
        { status: 408, body: "", expected: "The upload timed out" },
        { status: 413, body: "<html>Too large</html>", expected: "The server rejected the file size" },
        { status: 502, body: "", expected: "The server connection was interrupted" },
        { status: 504, body: "Gateway Timeout", expected: "The server took too long" },
        { status: 201, body: "", expected: "The upload response was incomplete" },
    ];
    let currentCase;
    await page.route("**/api/conversations/*/attachments", (route) => route.fulfill(currentCase));
    for (const { expected, ...response } of cases) {
        currentCase = response;
        await page.getByLabel("Attach files", { exact: true }).setInputFiles({
            name: "publication.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.alloc(Math.floor(5.8 * 1024 * 1024)),
        });
        await expect(page.locator("#upload-status")).toContainText("Some files need attention");
        await expect(page.locator("#attachment-list")).toContainText(expected);
        await expect(page.locator("#attachment-list")).not.toContainText("JSON");
        await expect(page.locator("#message")).toHaveValue("Keep these clinical modelling instructions");
    }
    await page.unroute("**/api/conversations/*/attachments");
    const { sourcePdf } = await import("./fixtures/pdf.mjs");
    await page.getByLabel("Attach files", { exact: true }).setInputFiles({
        name: "publication.pdf",
        mimeType: "application/pdf",
        buffer: sourcePdf(Math.floor(5.8 * 1024 * 1024)),
    });
    await expect(page.locator("#upload-status")).toContainText("1 file added");
    await expect(page.locator("#attachment-list")).toContainText("Text ready");
});

test("signed-out users have a visible header sign-in on every workspace view and after logout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat/#help-files");
    const signIn = page.getByRole("link", { name: "Sign in", exact: true });
    for (const name of ["Help", "Models", "Governance", "Chat"]) {
        await page.getByRole("tab", { name, exact: true }).click();
        await expect(signIn).toBeInViewport();
        if (name !== "Help")
            expect(await page.locator("body").innerText()).not.toMatch(/Sign in to|Sign in for|Sign in and/);
        await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(1);
    }
    await signIn.click();
    await page.locator("#oidc-login").click();
    await expect(signIn).toBeHidden();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(signIn).toBeInViewport();
});

test("expired sessions reveal header sign-in and preserve unsent instructions", async ({ page }) => {
    await login(page);
    await settings(page, false);
    await page.locator("#message").fill("Keep this modelling request");
    await page.route("**/chat/api/session", (route) =>
        route.fulfill({
            json: {
                enabled: true,
                authenticated: false,
                reviewEnabled: true,
                identityEnabled: false,
                oidcEnabled: true,
                providers: [],
            },
        }),
    );
    await page.route("**/chat/api/conversations", (route) =>
        route.fulfill({ status: 401, json: { error: "Sign in to continue." } }),
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeHidden();
    await expect(page.locator("#message")).toHaveValue("Keep this modelling request");
    await expect(page.locator("#message")).toBeDisabled();
});

test("header sign-in reveals native sign-in from another workspace tab", async ({ page }) => {
    await page.route("**/chat/api/session", (route) =>
        route.fulfill({
            json: {
                enabled: true,
                authenticated: false,
                identityEnabled: true,
                identitySetupRequired: false,
                oidcEnabled: false,
                providers: [],
            },
        }),
    );
    await page.goto("/chat/#help");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#local-login")).toBeVisible();
    await expect(page.locator("#local-username")).toBeFocused();
});

test("chat projects group new and existing conversations and removal preserves their messages", async ({ page }) => {
    await login(page);
    await send(page, "Existing renal conversation");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await settings(page, false);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Create chat project" });
    await dialog.getByLabel("Project name").fill("Kidney care");
    await dialog.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#chat-project-context")).toContainText("Kidney care");
    await send(page, "Plan a kidney template");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    let group = page.locator(".chat-project").filter({ has: page.locator("summary", { hasText: "Kidney care" }) });
    await expect(group.getByRole("button", { name: "Plan a kidney template", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Move Existing renal conversation to a project", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Move conversation" });
    await dialog.getByLabel("Chat project").selectOption({ label: "Kidney care" });
    await dialog.getByRole("button", { name: "Move chat", exact: true }).click();
    await expect(group.locator(".conversation-row")).toHaveCount(2);
    await group.getByRole("button", { name: "Settings for Kidney care", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Project settings" });
    await dialog.getByLabel("Project name").fill("Renal care");
    await dialog.getByRole("button", { name: "Save project", exact: true }).click();
    await expect(page.locator("#chat-project-context")).toContainText("Renal care");
    await page.reload();
    group = page.locator(".chat-project");
    await expect(group.locator("summary")).toHaveText("Renal care (2)");
    await expect(group.getByRole("button", { name: "Existing renal conversation", exact: true })).toBeHidden();
    await group.locator("summary").click();
    await group.getByRole("button", { name: "Existing renal conversation", exact: true }).click();
    await expect(page.locator(".message.user")).toContainText("Existing renal conversation");
    const deleteChat = group.getByRole("button", { name: "Delete Plan a kidney template", exact: true });
    await expect(deleteChat).toHaveCSS("opacity", "1");
    page.once("dialog", (dialog) => dialog.dismiss());
    await deleteChat.click();
    await expect(group.locator(".conversation-row")).toHaveCount(2);
    page.once("dialog", (dialog) => dialog.accept());
    await deleteChat.click();
    await expect(group.locator(".conversation-row")).toHaveCount(1);
    page.once("dialog", (dialog) => dialog.accept());
    await group.getByRole("button", { name: "Delete project Renal care", exact: true }).click();
    await expect(page.locator(".chat-project")).toHaveCount(0);
    await expect(page.locator(".conversation-row")).toHaveCount(1);
    await expect(page.locator(".message.user")).toContainText("Existing renal conversation");
});

test("chat projects are usable with keyboard navigation on phones", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.getByRole("button", { name: "Toggle conversations", exact: true }).click();
    await settings(page, false);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create chat project" });
    await expect(dialog.getByLabel("Project name")).toBeFocused();
    await dialog.getByLabel("Project name").fill("Kidney care");
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
    ).toEqual([]);
    await dialog.getByLabel("Project name").press("Enter");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Toggle conversations", exact: true }).click();
    await page.getByRole("button", { name: "New chat in Kidney care", exact: true }).click();
    await expect(page.locator("#message")).toBeFocused();
    await expect(page.locator("#chat-project-context")).toContainText("Kidney care");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Copilot setup stays in Help and only administrators can reveal the connection key", async ({ page }) => {
    await page.goto("/chat/#help-copilot");
    await expect(page.getByRole("heading", { name: "Connect Microsoft Copilot Studio", exact: true })).toBeVisible();
    await expect(page.getByLabel("Server address", { exact: true })).toHaveValue("http://127.0.0.1:8359/mcp");
    await expect(page.getByRole("button", { name: "Get connection key" })).toBeHidden();
    await page.route("**/chat/api/session", (route) =>
        route.fulfill({
            json: {
                authenticated: true,
                enabled: false,
                identityEnabled: true,
                user: { name: "Owner", roles: ["modelling-administrator"] },
                csrf: "fixture",
                mcpConnection: { url: "https://models.example/mcp", header: "X-Workspace-Key" },
            },
        }),
    );
    await page.route("**/chat/api/identity/users", (route) =>
        route.fulfill({ json: { users: [], serviceAccounts: [], audit: { events: [] } } }),
    );
    await page.route("**/chat/api/identity/mcp-connection", (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
        return route.fulfill({ json: { key: "synthetic-workspace-key" } });
    });
    await page.reload();
    await expect(page.getByLabel("API key header", { exact: true })).toHaveValue("X-Workspace-Key");
    await page.getByRole("button", { name: "Get connection key" }).click();
    const key = page.getByLabel("Workspace connection key", { exact: true });
    await expect(key).toHaveValue("synthetic-workspace-key");
    await expect(key).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Hide key", exact: true }).click();
    await expect(key).toHaveValue("");
    await expect(key).toBeHidden();
    await page.getByRole("button", { name: "Get connection key" }).click();
    await expect(key).toHaveValue("synthetic-workspace-key");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(key).toHaveValue("");
});

test("project repository folders and saved destinations survive new chats and reloads", async ({ page }) => {
    await login(page);
    await addRepository(page);
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await settings(page);
    await page.getByLabel("Repository folder", { exact: true }).fill("AKI");
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    await expect(page.locator("#save-destination-status")).toContainText("AKI/");
    const repository = await page.getByLabel("Save artifacts to").inputValue();
    await settings(page, false);
    await page.locator("#new-chat").click();
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(repository);
    await expect(page.getByLabel("Repository folder", { exact: true })).toHaveValue("AKI");
    await send(page, "inspect repository");
    await expect(page.locator(".message.assistant")).toContainText("Personal save available");
    await page.reload();
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(repository);
    await expect(page.getByLabel("Repository folder", { exact: true })).toHaveValue("AKI");
    await settings(page, false);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create chat project" });
    await dialog.getByLabel("Project name", { exact: true }).fill("Renal care");
    await expect(dialog.getByLabel("Default repository", { exact: true })).toHaveValue(repository);
    await dialog.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel("Repository folder", { exact: true })).toHaveValue("Renal-care");
    await settings(page);
    await page.getByLabel("Repository folder", { exact: true }).fill("Renal/Reviewed");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    await settings(page, false);
    await page.locator("#new-chat").click();
    await expect(page.getByLabel("Repository folder", { exact: true })).toHaveValue("Renal/Reviewed");
    await settings(page);
    await page.getByLabel("Repository folder", { exact: true }).fill("Temporary");
    await page.getByRole("button", { name: "Use project folder", exact: true }).click();
    await expect(page.getByLabel("Repository folder", { exact: true })).toHaveValue("Renal/Reviewed");
    await settings(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Chat settings", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("chat waits for saved destination metadata before allowing a new conversation", async ({ page }) => {
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    await page.route("**/api/conversations", async (route) => {
        if (route.request().method() === "GET") await pending;
        await route.continue();
    });
    await login(page);
    await expect(page.locator("#new-chat")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add files and images", exact: true })).toBeDisabled();
    release();
    await expect(page.locator("#new-chat")).toBeEnabled();
});

test("settings gear opens an accessible overlay and leaves the composer unobstructed when closed", async ({ page }) => {
    await login(page);
    for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
    ]) {
        await page.setViewportSize(viewport);
        const gear = page.getByRole("button", { name: "Chat settings", exact: true });
        await expect(gear).toBeInViewport();
        await expect(page.getByLabel("Save artifacts to")).toBeHidden();
        const before = await page.locator("#message").boundingBox();
        await gear.click();
        const overlay = page.getByRole("dialog", { name: "Workspace settings", exact: true });
        await expect(overlay).toBeVisible();
        await expect(overlay.getByLabel("Save artifacts to")).toBeVisible();
        await expect(overlay.locator("#provider-settings > summary")).toBeVisible();
        await expect(overlay.locator("#personal-settings > summary")).toBeVisible();
        expect(await overlay.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.keyboard.press("Escape");
        await expect(overlay).toBeHidden();
        await expect(gear).toBeFocused();
        expect(await page.locator("#message").boundingBox()).toEqual(before);
    }
});

test("moving a chat previews artefact paths, requires confirmation and adopts the project destination", async ({
    page,
}) => {
    await login(page);
    await addRepository(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await page.getByLabel("Repository folder", { exact: true }).fill("Old");
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    await expect(page.locator("#save-destination-status")).toContainText("Old/");
    await send(page, "Move my renal models");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Create chat project" });
    await dialog.getByLabel("Project name").fill("AKI");
    await dialog.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(dialog).toBeHidden();
    let commits = 0;
    await page.route("**/move-preview", async (route) => {
        const response = await route.fetch(),
            data = await response.json();
        // The service's remote transaction is covered separately. Exercise the
        // actual confirmation UI with a synthetic file list and real chat storage.
        await route.fulfill({
            response,
            json: {
                ...data,
                moves: [
                    { from: "Old/model.adl", to: "AKI/archetypes/model.adl" },
                    { from: "Old/model.oet", to: "AKI/templates/oet/model.oet" },
                ],
            },
        });
    });
    await page.route("**/move", async (route) => {
        commits++;
        await route.continue();
    });
    await page.getByRole("button", { name: "Move Move my renal models to a project", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Move conversation" });
    await dialog.getByLabel("Chat project").selectOption({ label: "AKI" });
    await dialog.getByRole("button", { name: "Move chat", exact: true }).click();
    await expect(dialog.locator("#move-chat-preview")).toContainText("AKI/templates/oet/model.oet");
    expect(commits).toBe(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(commits).toBe(0);
    await page.getByRole("button", { name: "Move Move my renal models to a project", exact: true }).click();
    await dialog.getByLabel("Chat project").selectOption({ label: "AKI" });
    await dialog.getByRole("button", { name: "Move chat", exact: true }).click();
    await dialog.getByRole("button", { name: "Move chat and artefacts", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(commits).toBe(1);
    await page.getByRole("button", { name: "Move my renal models", exact: true }).click();
    await settings(page);
    await expect(page.getByLabel("Repository folder", { exact: true })).toHaveValue("AKI");
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(/^[a-f0-9-]{36}$/);
});

test("saved artefacts expose current paths and exact-version links after reload and moves", async ({
    page,
    context,
}) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page);
    await addRepository(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    const repository = await page.getByLabel("Save artifacts to").inputValue();
    await send(page, "Link my saved files");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    let path = "AKI/data/json/terminology/codes.json",
        commit = "a".repeat(40);
    await page.route(/\/api\/conversations\/[a-f0-9-]{36}$/, async (route) => {
        const response = await route.fetch(),
            data = await response.json();
        await route.fulfill({
            response,
            json: {
                ...data,
                artifacts: [
                    {
                        repository,
                        path,
                        folder: "AKI",
                        commit,
                        destination: {
                            kind: "github",
                            url: "https://github.com/example/personal-models",
                            branch: "main",
                        },
                    },
                ],
            },
        });
    });
    await page.reload();
    await page.getByRole("button", { name: "Link my saved files", exact: true }).click();
    const files = page.locator("#conversation-artifacts");
    await files.locator("summary").click();
    await expect(files.getByRole("link", { name: "Version history", exact: true })).toHaveAttribute(
        "href",
        /\/commits\/main\//,
    );
    await expect(files).toContainText(path);
    await expect(files.getByRole("link", { name: "Open file", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/example/personal-models/blob/main/" + path,
    );
    await expect(files.getByRole("link", { name: "Saved version", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/example/personal-models/blob/" + commit + "/" + path,
    );
    await files.getByRole("button", { name: "Copy path", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path);
    await files.getByRole("button", { name: "Copy version link", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "https://github.com/example/personal-models/blob/" + commit + "/" + path,
    );
    await page.route("**/api/connections", (route) =>
        route.fulfill({ json: { personal: [], enterprise: [], enterpriseUnavailable: false } }),
    );
    await page.reload();
    await page.getByRole("button", { name: "Link my saved files", exact: true }).click();
    await files.locator("summary").click();
    await expect(files.getByRole("link", { name: "Open file", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/example/personal-models/blob/main/" + path,
    );
    path = "Renal/data/json/terminology/codes.json";
    commit = "b".repeat(40);
    await page.getByRole("button", { name: "Link my saved files", exact: true }).click();
    await expect(files).toContainText(path);
    await expect(files.getByRole("link", { name: "Saved version", exact: true })).toHaveAttribute(
        "href",
        "https://github.com/example/personal-models/blob/" + commit + "/" + path,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Toggle conversations", exact: true }).click();
    await page.locator("#new-chat").click();
    await expect(files).toBeHidden();
});

test("AQL workspace configures a private CDR, validates, runs and displays safe results", async ({ page }) => {
    await page.goto("/chat/auth/login");
    await page.getByRole("tab", { name: "AQL workspace" }).click();
    await page.getByRole("button", { name: "Manage connections" }).click();
    await page.getByRole("button", { name: "Add CDR connection" }).click();
    await page.locator("#cdr-name").fill("Development CDR");
    await page.locator("#cdr-baseUrl").fill("https://cdr.example");
    await page.locator("#cdr-auth").selectOption("bearer");
    await page.locator("#cdr-token").fill("fixture-private-token");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.locator("#cdr-form")).toBeHidden();
    await page.locator("#cdr-connection-list").getByRole("button", { name: "Test", exact: true }).click();
    await expect(page.locator("#cdr-settings-status")).toContainText("Connection ready");
    await expect(page.locator("#cdr-token")).toHaveValue("");
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator("#aql-editor").fill("SELECT e/ehr_id/value FROM EHR e LIMIT 10");
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.locator("#aql-findings")).toContainText("PASS");
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await expect(page.locator("#aql-result-summary")).toContainText("1 rows");
    await expect(page.locator("#aql-result-body")).toContainText("<img src=x");
    expect(await page.evaluate(() => window.__cdrInjected)).toBeUndefined();
    await page.locator("#aql-result-view").selectOption("json");
    await expect(page.locator("#aql-result-body pre")).toContainText('"columns"');
    await page.locator("#aql-save-name").fill("Example query");
    await page.getByRole("button", { name: "Save query", exact: true }).click();
    await expect(page.locator("#aql-saved-list")).toContainText("Example query");
    await expect(page.locator("#aql-history-list")).toContainText("SUCCEEDED");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/aql-workspace-mobile.png", fullPage: true });
});

test("AQL cancellation and model paths remain separate from chat", async ({ page }) => {
    await page.goto("/chat/auth/login");
    await page.getByRole("tab", { name: "AQL workspace" }).click();
    await page.getByRole("button", { name: "Manage connections" }).click();
    await page.getByRole("button", { name: "Add CDR connection" }).click();
    await page.locator("#cdr-name").fill("Sandbox");
    await page.locator("#cdr-baseUrl").fill("https://cdr.example");
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.locator("#cdr-form")).toBeHidden();
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator("#aql-editor").fill("SELECT e FROM EHR e WHERE e/name/value = 'slow'");
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await expect(page.locator("#aql-progress")).toBeVisible();
    await page.getByRole("button", { name: "Cancel query", exact: true }).click();
    await expect(page.locator("#aql-notice")).toContainText("Query cancelled");
    await expect(page.locator("#aql-results")).toBeHidden();
    await page.locator("#aql-model-section summary").click();
    await page
        .locator("#aql-files")
        .setInputFiles({ name: "fixture.opt.xml", mimeType: "application/xml", buffer: Buffer.from("<template/>") });
    await page.getByRole("button", { name: "Inspect paths", exact: true }).click();
    await expect(page.locator("#aql-use-template")).toBeChecked();
    await page.locator("#aql-paths").getByRole("checkbox").nth(1).check();
    await page.getByRole("button", { name: "Generate query from selected paths" }).click();
    await expect(page.locator("#aql-editor")).toContainText("SELECT");
    await expect(page.locator("#aql-editor")).toHaveValue(/content\[at0001\]/);
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await expect(page.locator("#aql-findings")).toContainText("selected-template paths");
    await page.screenshot({ path: "/tmp/aql-workspace-desktop.png", fullPage: true });
});

test("AQL loads a package, clears selections and drafts directly in its sole query editor without leaking results", async ({
    page,
}) => {
    const ref = "a".repeat(40),
        path = "AKI/templates/oet/aki.oet";
    let compiled = false;
    await page.route("**/chat/api/cdr/connections", (route) =>
        route.fulfill({ json: { items: [{ id: "synthetic-cdr", name: "Synthetic CDR", enabled: true }] } }),
    );
    await page.route("**/chat/api/cdr/execute", (route) => {
        expect(route.request().postDataJSON().parameters).toEqual({ ehr: "synthetic-private-parameter" });
        const result = { columns: [{ name: "patient" }], rows: [["synthetic-private-result"]] };
        return route.fulfill({
            json: { ...result, json: result, raw: JSON.stringify(result), count: 1, duration_ms: 10, has_more: false },
        });
    });
    await page.route("**/chat/api/aql-repository/list", (route) =>
        route.fulfill({
            json: {
                ref,
                items: [
                    { path: "AKI/archetypes/encounter.adl", type: "blob", ref },
                    { path, type: "blob", ref },
                ],
            },
        }),
    );
    await page.route("**/chat/api/aql-repository/package", (route) => {
        expect(route.request().postDataJSON()).toMatchObject({ path, ref });
        return route.fulfill({
            json: {
                exists: true,
                path,
                ref,
                content: "<template/>",
                dependencySource: "verified_manifest",
                dependencies: [{ identifier: "openEHR-EHR-COMPOSITION.encounter.v1", content: "exact fixture ADL" }],
            },
        });
    });
    await page.route("**/chat/api/cdr/compile", (route) => {
        expect(route.request().postDataJSON().dependencies).toEqual([
            { identifier: "openEHR-EHR-COMPOSITION.encounter.v1", content: "exact fixture ADL" },
        ]);
        compiled = true;
        return route.fulfill({ json: { valid: true, output: { format: "opt14_xml", content: "<compiled/>" } } });
    });
    await login(page);
    await addRepository(page);
    await settings(page, false);
    await page.getByRole("tab", { name: "AQL workspace" }).click();
    await page.locator("#aql-model-section summary").click();
    await expect(page.locator("#aql-source option").filter({ hasText: "My models" })).toHaveCount(1);
    await page.locator("#aql-source").selectOption({ label: "My models" });
    await page.getByRole("button", { name: "Load source", exact: true }).click();
    await expect(page.locator("#aql-model option:checked")).toHaveText(path);
    await page.getByRole("button", { name: "Inspect paths", exact: true }).click();
    await expect(page.locator("#aql-model-status")).toContainText("1 archetypes loaded · package hashes verified");
    await page.locator("#aql-paths").getByRole("checkbox").nth(1).check();
    await expect(page.locator("#aql-paths")).toContainText("1 selected");
    await page.locator("#aql-path-filter").fill("no-match");
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await page.locator("#aql-path-filter").fill("");
    await expect(page.locator("#aql-paths input:checked")).toHaveCount(0);
    await expect(page.locator("#aql-paths")).toContainText("0 selected");
    await expect(page.locator("#aql-generate")).toBeDisabled();
    expect(compiled).toBe(true);
    await page.locator("#aql-editor").fill("SELECT m/ FROM COMPOSITION m");
    await page.locator("#aql-editor").evaluate((node) => {
        node.focus();
        node.setSelectionRange(9, 9);
    });
    await page.locator("#aql-editor").press("Control+Space");
    await expect(page.getByRole("option", { name: "m/content[at0001]", exact: true })).toBeVisible();
    await page.locator("#aql-editor").press("Enter");
    await expect(page.locator("#aql-editor")).toHaveValue("SELECT m/content[at0001] FROM COMPOSITION m");
    await expect(page.locator("#aql-suggestions")).toBeHidden();
    await page.locator("#aql-editor").fill("SELECT m/missing FROM COMPOSITION m");
    await page.locator("#aql-editor").evaluate((node) => node.setSelectionRange(16, 16));
    await page.locator("#aql-editor").press("Control+Space");
    await expect(page.locator("#aql-suggestions")).toBeHidden();
    await page.locator("#aql-connection").selectOption("synthetic-cdr");
    await page
        .locator("#aql-editor")
        .fill("SELECT m/name/value FROM COMPOSITION m WHERE m/name/value = 'synthetic-private-literal'");
    await page.getByText("Parameters and pagination", { exact: true }).click();
    await page.locator("#aql-parameters").fill('{"ehr":"synthetic-private-parameter"}');
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await expect(page.locator("#aql-result-body")).toContainText("synthetic-private-result");
    await page.locator("#aql-intent").fill("Return body weight and laboratory results");
    const drafting = page.waitForRequest("**/chat/api/aql-draft");
    await page.getByRole("button", { name: "Ask assistant to write AQL" }).click();
    const payload = (await drafting).postData();
    expect(payload).not.toContain("synthetic-private-");
    expect(JSON.parse(payload).intent).toBe("Return body weight and laboratory results");
    await expect(page.locator("#panel-aql")).toBeVisible();
    await expect(page.locator("#aql-editor")).toHaveValue(/SELECT m\/content\[at0001\]/);
    await expect(page.locator("#aql-notice")).toContainText("Draft placed in the AQL query box");
    await expect(page.locator("#message")).not.toHaveValue(/synthetic-private-/);
    expect(browserErrors).toEqual([]);
});

test("repository settings show a specific write refusal and preserve selection while access is repaired", async ({
    page,
}) => {
    let blocked = true;
    await page.route("**/chat/api/connections", async (route) => {
        if (route.request().method() === "POST") {
            blocked = false;
            return route.continue();
        }
        const response = await route.fetch();
        const data = await response.json();
        if (blocked)
            for (const item of data.personal)
                if (item.kind === "github")
                    item.lastWriteError = {
                        code: "GITHUB_CONTENTS_WRITE_REQUIRED",
                        message: "GitHub refused this token. Grant Contents: Read and write, then Save connection.",
                    };
        await route.fulfill({ response, json: data });
    });
    await login(page);
    await addRepository(page);
    blocked = true;
    await settings(page);
    await page.getByLabel("Save artifacts to").selectOption({ label: "My models · main" });
    await page.getByRole("button", { name: "Save repository selection", exact: true }).click();
    const selected = await page.getByLabel("Save artifacts to").inputValue();
    await settings(page);
    await page.locator("#personal-settings > summary").click();
    await expect(page.locator("#connection-list")).toContainText("Contents: Read and write");
    await page.getByRole("button", { name: "Update access for My models", exact: true }).click();
    await page.getByRole("button", { name: "Save connection", exact: true }).click();
    await expect(page.locator("#connection-list")).not.toContainText("Last save failed");
    await expect(page.getByLabel("Save artifacts to")).toHaveValue(selected);
});

test("template package confirmation lists every dependency and escapes source contents", async ({ page }) => {
    await login(page);
    let finish;
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    await page.route("**/chat/api/conversations/*", async (route) => {
        if (route.request().method() === "GET") await pending;
        await route.fallback();
    });
    await page.route("**/chat/api/conversations/*/messages", async (route) =>
        route.fulfill({
            contentType: "text/event-stream",
            body:
                "data: " +
                JSON.stringify({
                    type: "approval",
                    id: "package-review",
                    tool: "personal_repository_save",
                    arguments: {
                        path: "AKI/templates/oet/renal.oet",
                        package: {
                            files: [
                                { path: "AKI/templates/oet/renal.oet", changed: true, content: "<template/>" },
                                {
                                    path: "AKI/archetypes/openEHR-EHR-COMPOSITION.encounter.v1.adl",
                                    changed: false,
                                    content: "<script>window.packageInjected=true</script>",
                                },
                                {
                                    path: "AKI/data/json/template-packages/renal.oet.json",
                                    changed: true,
                                    content: "{}",
                                },
                            ],
                        },
                    },
                }) +
                "\n\ndata: " +
                JSON.stringify({ type: "done" }) +
                "\n\n",
        }),
    );
    await send(page, "Save the complete template package");
    await expect(page.locator(".package-files li")).toHaveCount(3);
    await expect(page.locator(".package-files")).toContainText("COMPOSITION.encounter.v1.adl · already present");
    await expect(page.locator(".approval pre")).toContainText("<script>");
    expect(await page.evaluate(() => window.packageInjected)).toBeUndefined();
    await expect(page.getByRole("button", { name: "Confirm save", exact: true })).toBeVisible();
    finish();
});

test("reload reconnects to pending confirmation without repeating the write", async ({ page }) => {
    await login(page);
    await send(page, "save");
    await expect(page.getByRole("button", { name: "Confirm save", exact: true })).toBeVisible();
    await page.reload();
    await page
        .getByRole("navigation", { name: "Your conversations" })
        .getByRole("button", { name: "save", exact: true })
        .click();
    await expect(page.getByRole("button", { name: "Confirm save", exact: true })).toBeVisible();
    await expect(page.locator("#chat-form")).toHaveAttribute("aria-busy", "true");
    await page.getByRole("button", { name: "Confirm save", exact: true }).click();
    await expect(page.locator(".message.assistant")).toContainText("saved after your confirmation");
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await expect(page.locator(".message.user")).toHaveCount(1);
});

test("stopped response offers a working continue control", async ({ page }) => {
    await login(page);
    await send(page, "wait");
    await page.getByRole("button", { name: "Stop response", exact: true }).click();
    const resume = page.getByRole("button", { name: "Continue from saved progress", exact: true });
    await expect(resume).toBeVisible();
    await resume.click();
    await expect(page.locator(".message.assistant").last()).toContainText("default");
    await expect(page.locator(".message.user").last()).toContainText("retained drafts");
});

test("independent review selection reaches the task API and resets after the accepted message", async ({ page }) => {
    await login(page);
    await page.getByLabel("Context for next message").selectOption("independent");
    const request = page.waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith("/messages"),
    );
    await send(page, "Review this template independently");
    expect((await request).postDataJSON().sessionMode).toBe("independent");
    await expect(page.locator(".message.assistant").last()).toContainText("default");
    await expect(page.getByLabel("Context for next message")).toHaveValue("auto");
    expect(browserErrors).toEqual([]);
});

test("session renewal follows user activity rather than an idle open tab", async ({ page }) => {
    await page.clock.install();
    await login(page);
    let renewals = 0;
    await page.route("**/chat/auth/keepalive", async (route) => {
        renewals++;
        expect(route.request().method()).toBe("POST");
        expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
        await route.fulfill({ json: { expires: Date.now() + 3600000 } });
    });
    await page.locator("#message").fill("Unsent work");
    await page.clock.fastForward(60000);
    await expect.poll(() => renewals).toBe(1);
    await page.clock.fastForward(180000);
    expect(renewals).toBe(1);
    await page.locator("#message").fill("Still working");
    await page.clock.fastForward(60000);
    await expect.poll(() => renewals).toBe(2);
    await expect(page.locator("#message")).toHaveValue("Still working");
});

test("native sign-in exposes signup, failure counts and email-free recovery on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/chat/api/session", (route) =>
        route.fulfill({
            json: {
                authenticated: false,
                enabled: true,
                identityEnabled: true,
                identitySetupRequired: false,
                signupEnabled: true,
                oidcEnabled: false,
                providers: [],
            },
        }),
    );
    await page.route("**/chat/auth/local", (route) =>
        route.fulfill({
            status: 401,
            json: {
                error: "Sign-in failed. 1 of 5 attempts used; 4 attempts remain. Check your username, password and authenticator code, or use account recovery.",
                login: { failedAttempts: 1, remainingAttempts: 4, locked: false },
            },
        }),
    );
    await page.route("**/chat/auth/recovery-code", async (route) => {
        expect(route.request().postDataJSON().username).toBe("member");
        await route.fulfill({
            json: {
                mfaSetupRequired: true,
                csrf: "synthetic",
                totpSecret: "SYNTHETIC",
                otpAuthUrl: "otpauth://totp/synthetic",
            },
        });
    });
    await page.goto("/chat/#chat");
    await expect(page.locator("#account-dialog")).toBeHidden();
    await page.locator("#sign-in").click();
    await expect(page.locator("#show-signup")).toBeVisible();
    await page.locator("#show-signup").click();
    await expect(page.locator("#signup-form")).toBeVisible();
    await page.locator("#back-to-signin").click();
    await page.locator("#local-username").fill("member");
    await page.locator("#local-password").fill("incorrect-password");
    await page.locator("#local-login button[type=submit]").click();
    await expect(page.locator("#identity-auth-notice")).toContainText("4 attempts remain");
    await page.locator("#show-code-recovery").click();
    await expect(page.locator("#code-recovery-username")).toHaveValue("member");
    await page.locator("#code-recovery-code").fill("saved-synthetic-code");
    await page.locator("#code-recovery-password").fill("A-new-password-2026!");
    await page.locator("#code-recovery-form button[type=submit]").click();
    await expect(page.locator("#mfa-enrollment")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const failedImage of [false, true]) {
    test(`authenticator enrollment offers a private QR and manual fallback (image failure: ${failedImage})`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.route("**/chat/api/session", (route) =>
            route.fulfill({
                json: {
                    authenticated: false,
                    enabled: true,
                    identityEnabled: true,
                    mfaSetupRequired: true,
                    csrf: "synthetic-csrf",
                    totpSecret: "JBSWY3DPEHPK3PXP",
                    otpAuthUrl: "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP",
                    providers: [],
                },
            }),
        );
        await page.route("**/chat/auth/mfa-qr", (route) => {
            expect(new URL(route.request().url()).search).toBe("");
            return failedImage
                ? route.fulfill({ status: 503, body: "Unavailable" })
                : route.fulfill({ contentType: "image/png", body: imagePng });
        });
        await page.route("**/chat/auth/mfa", (route) => {
            expect(route.request().postDataJSON()).toEqual({ code: "123456" });
            return route.fulfill({ json: { csrf: "next-csrf", recoveryCodes: ["synthetic-recovery"] } });
        });
        await page.goto("/chat/");
        await expect(page.locator("#mfa-enrollment")).toBeVisible();
        if (failedImage) {
            await expect(page.locator("#mfa-qr-error")).toBeVisible();
            await expect(page.locator("#mfa-qr")).toBeHidden();
        } else {
            await expect(page.locator("#mfa-qr")).toBeVisible();
            await expect.poll(() => page.locator("#mfa-qr").evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
            await expect(page.locator("#totp-secret")).toBeHidden();
            await page.locator("#mfa-manual summary").click();
        }
        await expect(page.locator("#totp-secret")).toHaveText("JBSWY3DPEHPK3PXP");
        await expect(page.locator("#totp-secret")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (!failedImage) {
            await page.locator("#close-account-dialog").click();
            await expect(page.locator("#mfa-qr")).not.toHaveAttribute("src");
            await page.locator("#sign-in").click();
            await expect(page.locator("#mfa-qr")).toBeVisible();
        }
        await page.locator("#mfa-code").fill("123456");
        await page.evaluate(async () => {
            const detail = await (await fetch("/chat/api/session")).json();
            document.dispatchEvent(new CustomEvent("workspace:session", { detail }));
        });
        await expect(page.locator("#mfa-code")).toHaveValue("123456");
        await page.locator("#mfa-form button").click();
        await expect(page.locator("#recovery-codes")).toBeVisible();
        await expect(page.locator("#mfa-qr")).not.toHaveAttribute("src");
        await expect(page.locator("#otp-auth-link")).not.toHaveAttribute("href");
        await expect(page.locator("#totp-secret")).toBeEmpty();
    });
}

test("account overlay keeps the workspace clear and offers owner setup without leaving the current tab", async ({
    page,
}) => {
    await page.route("**/chat/api/session", (route) =>
        route.fulfill({
            json: {
                authenticated: false,
                enabled: true,
                identityEnabled: true,
                identitySetupRequired: true,
                signupEnabled: false,
                oidcEnabled: true,
                providers: [],
            },
        }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat/#help");
    await expect(page.locator("#account-dialog")).toBeHidden();
    await expect(page.locator("#owner-bootstrap")).toBeHidden();
    await page.locator("#sign-in").click();
    await expect(page.getByRole("dialog", { name: "Welcome to your workspace", exact: true })).toBeVisible();
    await expect(page.locator("#oidc-login")).toBeVisible();
    await expect(page.locator("#signup-prompt")).toBeHidden();
    await page.locator("#show-owner-setup").click();
    await expect(page.locator("#owner-bootstrap")).toBeVisible();
    await expect(page.locator("#oidc-login")).toBeHidden();
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.locator("#bootstrap-password").fill("Synthetic-private-password");
    expect(await page.locator("#account-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(
        true,
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#account-dialog")).toBeHidden();
    await expect(page.locator("#sign-in")).toBeFocused();
    await expect(page.locator("#bootstrap-password")).toHaveValue("");
    await expect(page.locator("#panel-help")).toBeVisible();
});

test("FHIR workspace separates modelling, exact source validation and reviewed changes", async ({ page }) => {
    const requests = [];
    const project = {
        id: "fhir-demo",
        name: "FHIR demonstration",
        fhirVersion: "4.0.1",
        canonical: "https://example.test/fhir",
        packageId: "test.clinical",
        version: "0.1.0",
        publisher: "Test",
        repository: { provider: "github", url: "https://github.com/example/fhir", branch: "review", rootPath: "" },
        dependencies: [{ id: "hl7.fhir.r4.core", version: "4.0.1" }],
        sources: [],
        connections: {},
    };
    const resource = {
        resourceType: "StructureDefinition",
        id: "clinical-observation",
        name: "ClinicalObservation",
        title: '<img src=x onerror="window.fhirInjected=true">',
        url: "https://example.test/fhir/StructureDefinition/clinical-observation",
        version: "0.1.0",
        fhirVersion: "4.0.1",
        type: "Observation",
        baseDefinition: "http://hl7.org/fhir/StructureDefinition/Observation",
        differential: {
            element: [{ id: "Observation.status", path: "Observation.status", min: 1, max: "1", mustSupport: true }],
        },
    };
    await page.route("**/chat/api/fhir/execute", async (route) => {
        const input = route.request().postDataJSON();
        requests.push(input);
        const { tool, args } = input;
        let result;
        if (tool === "fhir_project")
            result =
                args.action === "list"
                    ? { items: [project] }
                    : { project, revision: "project-revision", artifacts: [] };
        else if (tool === "fhir_profile")
            result =
                args.action === "discover"
                    ? {
                          recommendation: "derive",
                          candidates: [
                              {
                                  canonical: resource.baseDefinition,
                                  packageId: "hl7.fhir.r4.core",
                                  packageVersion: "4.0.1",
                                  reason: "Retrieved configured dependency",
                              },
                          ],
                      }
                    : {
                          files: [
                              {
                                  path: "input/fsh/ClinicalObservation.fsh",
                                  content: "Profile: ClinicalObservation\nParent: Observation\n* status 1..1 MS",
                              },
                          ],
                          provenance: { parent: resource.baseDefinition },
                      };
        else if (tool === "fhir_fsh_compile")
            result = {
                success: true,
                files: [
                    {
                        path: "fsh-generated/resources/StructureDefinition-clinical-observation.json",
                        content: JSON.stringify(resource),
                    },
                ],
                evidence: { tool: "SUSHI", fixture: true },
            };
        else if (tool === "fhir_example_generate")
            result = {
                resource: {
                    resourceType: "Observation",
                    id: "synthetic-example",
                    status: "final",
                    meta: { profile: [resource.url] },
                },
                files: [
                    {
                        path: "input/examples/synthetic-example.json",
                        content: JSON.stringify({
                            resourceType: "Observation",
                            id: "synthetic-example",
                            status: "final",
                            meta: { profile: [resource.url] },
                        }),
                    },
                ],
                gaps: [{ path: "Observation.code", message: "Provide required synthetic code" }],
                synthetic: true,
                provenance: { kind: "synthetic-draft" },
            };
        else if (tool === "fhir_artifact" && args.action === "inspect")
            result = { resource, provenance: { packageId: "hl7.fhir.r4.core" } };
        else if (tool === "fhir_artifact" && args.action === "validate")
            result = {
                status: "FAIL",
                valid: false,
                diagnostics: [{ severity: "error", message: "Missing required field" }],
                evidence: { tool: "fixture-validator" },
            };
        else if (tool === "fhir_artifact" && args.action === "save") {
            if (!input.confirmation)
                return route.fulfill({
                    json: { confirmationRequired: true, confirmation: "fixture-ticket", tool, args },
                });
            result = { path: JSON.parse(args.arguments).path, revision: "saved-revision" };
        } else result = { items: [] };
        return route.fulfill({ json: { result } });
    });
    await login(page);
    await page.getByRole("tab", { name: "FHIR modelling", exact: true }).click();
    await expect(page.locator("#fhir-context")).toContainText("FHIR demonstration · FHIR 4.0.1");
    await expect(page.locator("#panel-models")).toBeHidden();
    await page.locator("#fhir-requirement").fill("Require status for a synthetic research observation.");
    await page.locator("#fhir-profile-id").fill("clinical-observation");
    await page.locator("#fhir-profile-name").fill("ClinicalObservation");
    await page.getByRole("button", { name: "Discover reusable profiles", exact: true }).click();
    await expect(page.locator("#fhir-candidates")).toContainText("hl7.fhir.r4.core");
    await page.getByRole("button", { name: "Generate draft FSH", exact: true }).click();
    await expect(page.locator("#fhir-source")).toHaveValue(/Profile: ClinicalObservation/);
    await page.getByRole("button", { name: "Compile FSH with SUSHI", exact: true }).click();
    await expect(page.locator("#fhir-validation-state")).toContainText("Generated resources require FHIR validation");
    await page
        .locator("#fhir-artifact-select")
        .selectOption("draft:fsh-generated/resources/StructureDefinition-clinical-observation.json");
    await expect(page.locator("#fhir-format")).toHaveValue("json");
    await page.getByRole("button", { name: "Inspect artifact", exact: true }).click();
    await expect(page.locator("#fhir-artifact-inspector")).toContainText("Observation.status");
    await expect(page.locator("#fhir-artifact-inspector")).toContainText(resource.title);
    expect(await page.evaluate(() => window.fhirInjected)).toBeUndefined();
    await page.getByRole("button", { name: "Validate exact artifact", exact: true }).click();
    await expect(page.locator("#fhir-validation-state")).toContainText("Validation result: FAIL");
    await page.locator("#fhir-source").fill(JSON.stringify({ ...resource, description: "Draft revised" }));
    await expect(page.locator("#fhir-validation-state")).toContainText("Not validated for current editor contents");
    await page.getByRole("button", { name: "Review draft save", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Review FHIR change" })).toBeVisible();
    expect(requests.filter((r) => r.confirmation)).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel change", exact: true }).click();
    await expect(page.locator("#fhir-notice")).toContainText("Change cancelled");
    expect(requests.filter((r) => r.confirmation)).toHaveLength(0);
    await page.getByRole("button", { name: "Review draft save", exact: true }).click();
    await page.getByRole("button", { name: "Confirm exact change", exact: true }).click();
    await expect(page.locator("#fhir-artifact-revision")).toContainText("saved-revision");
    expect(requests.filter((r) => r.confirmation)).toHaveLength(1);
    await page.getByText("Synthetic example generation", { exact: true }).click();
    await page.locator("#fhir-example-values").fill(JSON.stringify({ "Observation.status": "final" }));
    await page.getByRole("button", { name: "Generate synthetic example", exact: true }).click();
    await expect(page.locator("#fhir-artifact-path")).toHaveValue("input/examples/synthetic-example.json");
    await expect(page.locator("#fhir-validation-state")).toContainText("Review reported gaps");
    await expect(page.locator("#fhir-validation-profile")).toHaveValue(resource.url);
    await page.getByRole("button", { name: "Validate exact artifact", exact: true }).click();
    await expect(page.locator("#fhir-validation-state")).toContainText("FAIL");
    const exampleValidation = requests.filter((r) => r.tool === "fhir_artifact" && r.args.action === "validate").at(-1);
    expect(JSON.parse(exampleValidation.args.arguments).profiles).toHaveLength(1);
    expect(JSON.parse(exampleValidation.args.arguments).content.resourceType).toBe("Observation");
    await page.getByRole("tab", { name: "Cross-standard mappings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Cross-standard mappings", exact: true })).toBeVisible();
    await expect(page.locator("#mapping-project")).toHaveValue(project.id);
    await expect(page.locator("#panel-mappings")).toContainText("matching names do not establish equivalence");
});

test("FHIR project controls wait for pending loads before starting a new draft", async ({ page }) => {
    let finishLoad;
    const pending = new Promise((resolve) => {
        finishLoad = resolve;
    });
    await page.route("**/chat/api/fhir/execute", async (route) => {
        if (route.request().postDataJSON().args.action === "list") await pending;
        await route.fulfill({ json: { result: { items: [] } } });
    });
    await login(page);
    await page.getByRole("tab", { name: "FHIR modelling", exact: true }).click();
    await expect(page.locator("#panel-fhir")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#fhir-new-project")).toBeDisabled();
    await expect(page.locator("#fhir-project")).toBeDisabled();
    finishLoad();
    await expect(page.locator("#fhir-new-project")).toBeEnabled();
    await page.locator("#fhir-new-project").click();
    await page.locator('#fhir-project-form [name="name"]').fill("Draft after load");
    await expect(page.locator('#fhir-project-form [name="name"]')).toHaveValue("Draft after load");
});

test("FHIR project configuration is explicit, confirmed and usable on a small viewport", async ({ page }) => {
    let current = null;
    const writes = [];
    await page.route("**/chat/api/fhir/execute", async (route) => {
        const input = route.request().postDataJSON();
        if (input.args.action === "create") {
            if (!input.confirmation)
                return route.fulfill({ json: { confirmationRequired: true, confirmation: "create-ticket", ...input } });
            writes.push(input);
            current = { ...JSON.parse(input.args.document), id: input.args.projectId };
        }
        await route.fulfill({
            json: {
                result:
                    input.args.action === "list"
                        ? { items: current ? [current] : [] }
                        : { project: current, revision: "revision", artifacts: [] },
            },
        });
    });
    await login(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "FHIR modelling", exact: true }).click();
    await page.getByRole("button", { name: "New FHIR project", exact: true }).click();
    const form = page.locator("#fhir-project-form");
    await form.getByLabel("Project identifier", { exact: true }).fill("dev-fhir");
    await form.getByLabel("Project name", { exact: true }).fill("Development FHIR");
    await form.getByRole("combobox", { name: "FHIR release", exact: true }).fill("4.3.0");
    await form.getByLabel("Canonical base URL", { exact: true }).fill("https://example.test/dev-fhir");
    await form.getByLabel("Package ID", { exact: true }).fill("test.development.fhir");
    await form.getByLabel("Publisher", { exact: true }).fill("Synthetic test publisher");
    await form.getByLabel("Repository branch", { exact: true }).fill("dev");
    await form.getByRole("button", { name: "Review project changes", exact: true }).click();
    await expect(page.locator("#fhir-confirm-request")).toContainText("4.3.0");
    expect(writes).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Confirm exact change", exact: true }).click();
    await expect(page.locator("#fhir-context")).toContainText("Development FHIR · FHIR 4.3.0");
    expect(writes).toHaveLength(1);
    expect(current.repository.url).toBe("https://github.com/CzarMich/fhir_ig");
    expect(current.repository.branch).toBe("dev");
    expect(current.connections).toEqual({});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("FHIR imported XML download preserves original CRLF bytes until the source is edited", async ({ page }) => {
    const original =
        '<?xml version="1.0" encoding="UTF-8"?>\r\n<Patient xmlns="http://hl7.org/fhir">\r\n  <id value="synthetic-original"/>\r\n</Patient>\r\n';
    const project = {
        id: "xml-original",
        name: "XML original",
        fhirVersion: "4.0.1",
        canonical: "https://example.org/dev",
        packageId: "org.example.dev",
        version: "0.1.0",
        repository: {},
        connections: {},
    };
    const file = {
        path: "fhir/input/resources/original.xml",
        content: original,
        revision: "original-revision",
        metadata: { format: "xml", representation: "imported" },
    };
    await page.route("**/chat/api/fhir/execute", async (route) => {
        const { tool, args } = route.request().postDataJSON();
        const result =
            tool === "fhir_project"
                ? args.action === "list"
                    ? { items: [project] }
                    : { project, revision: "configuration-revision", artifacts: [file] }
                : file;
        await route.fulfill({ json: { result } });
    });
    await login(page);
    await page.getByRole("tab", { name: "FHIR modelling", exact: true }).click();
    await page.locator("#fhir-artifact-select").selectOption("saved:" + file.path);
    await expect(page.locator("#fhir-format")).toHaveValue("xml");
    const readFile = (await import("node:fs/promises")).readFile;
    const download = page.waitForEvent("download");
    await page.locator("#fhir-download").click();
    expect(await readFile(await (await download).path(), "utf8")).toBe(original);
    const revised = '<Patient xmlns="http://hl7.org/fhir"><id value="edited-copy"/></Patient>';
    await page.locator("#fhir-source").fill(revised);
    const editedDownload = page.waitForEvent("download");
    await page.locator("#fhir-download").click();
    expect(await readFile(await (await editedDownload).path(), "utf8")).toBe(revised);
});

test("FHIR external definitions are inspected before a hash-bound import and cancellation makes no changes", async ({
    page,
}) => {
    const project = {
        id: "external",
        name: "External definitions",
        fhirVersion: "4.0.1",
        canonical: "https://example.org/fhir",
        packageId: "test.external",
        version: "1.0.0",
    };
    const original = {
        resourceType: "ValueSet",
        id: "codes",
        url: "https://example.org/codes",
        version: "1.0.0",
        copyright: "Upstream licence",
    };
    const source = {
        kind: "resource",
        sha256: "a".repeat(64),
        resource: original,
        content: JSON.stringify(original),
        identity: original,
        provenance: { sourceUrl: "https://example.org/codes.json", sha256: "a".repeat(64) },
    };
    const mutations = [];
    await page.route("**/chat/api/fhir/execute", async (route) => {
        const input = route.request().postDataJSON();
        if (input.tool === "fhir_project")
            return route.fulfill({
                json: {
                    result:
                        input.args.action === "list"
                            ? { items: [project] }
                            : { project, revision: "configuration-revision", artifacts: [] },
                },
            });
        if (input.args.action === "import") {
            if (!input.confirmation)
                return route.fulfill({
                    json: {
                        confirmationRequired: true,
                        confirmation: "reviewed-source",
                        tool: input.tool,
                        args: input.args,
                    },
                });
            mutations.push(input);
        }
        return route.fulfill({ json: { result: source } });
    });
    await login(page);
    await page.getByRole("tab", { name: "FHIR modelling", exact: true }).click();
    await expect(page.locator("#fhir-context")).toContainText(project.name);
    await page.locator("#fhir-external-url").fill("https://example.org/codes.json");
    await page.getByRole("button", { name: "Inspect URL", exact: true }).click();
    await expect(page.locator("#fhir-external-result")).toContainText("Upstream licence");
    await expect(page.locator("#fhir-external-path")).toHaveValue("imported/ValueSet-codes.json");
    await page.getByRole("button", { name: "Review and import inspected source", exact: true }).click();
    await expect(page.locator("#fhir-confirm-request")).toContainText("configuration-revision");
    expect(mutations).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel change", exact: true }).last().click();
    expect(mutations).toHaveLength(0);
    await expect(page.locator("#fhir-notice")).toContainText("cancelled");
    await page.getByRole("button", { name: "Review and import inspected source", exact: true }).click();
    await page.getByRole("button", { name: "Confirm exact change", exact: true }).click();
    await expect(page.locator("#fhir-external-import")).toBeDisabled();
    expect(mutations).toHaveLength(1);
    expect(JSON.parse(mutations[0].args.arguments).expectedSha256).toBe(source.sha256);
});
