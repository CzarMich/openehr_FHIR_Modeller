// Opt-in browser acceptance against an isolated, running Dev stack. No API mocks.
// Requires an MFA-enabled synthetic account; credentials never enter the evidence.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const accountFile = process.env.FHIR_DEV_ACCOUNT_FILE;
if (!accountFile) throw new Error("Set FHIR_DEV_ACCOUNT_FILE to the private Dev account JSON file.");
const account = JSON.parse(await readFile(accountFile, "utf8"));
const origin = process.env.FHIR_DEV_ORIGIN || account.origin || "http://localhost:18350";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
    throw new Error("Live acceptance is restricted to explicitly isolated loopback Dev deployments.");
const out = resolve(process.env.FHIR_BROWSER_EVIDENCE_DIR || "test-results/fhir-live");
await mkdir(out, { recursive: true });
const evidence = {
    environment: "development",
    synthetic: true,
    mockedApis: false,
    startedAt: new Date().toISOString(),
    checks: [],
};
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
let signedIn = false;
function otp(secret) {
    const bits = [...secret]
        .map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0"))
        .join("");
    const bytes = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac("sha1", bytes).update(counter).digest();
    return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function check(name, action) {
    const started = Date.now();
    console.log("Live browser: " + name);
    const result = await action();
    evidence.checks.push({ name, success: true, elapsedMs: Date.now() - started });
    return result;
}
async function operation(button, tool, action, confirm = false) {
    const result = page.waitForResponse(
        (response) => {
            if (!response.url().endsWith("/chat/api/fhir/execute")) return false;
            const request = response.request().postDataJSON();
            return (
                request.tool === tool &&
                (!action || request.args.action === action) &&
                (!confirm || !!request.confirmation)
            );
        },
        { timeout: 670000 },
    );
    // A failed dialog assertion closes the browser before this pending response.
    // Observe rejection immediately so the original failure remains in evidence.
    result.catch(() => {});
    await button.click();
    if (confirm) {
        await expect(page.getByRole("dialog", { name: "Review FHIR change" })).toBeVisible();
        await page.getByRole("button", { name: "Confirm exact change", exact: true }).click();
    }
    const response = await result;
    const body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body));
    assert.ok(body.result, JSON.stringify(body));
    await expect(page.locator("#panel-fhir")).toHaveAttribute("aria-busy", "false", { timeout: 30000 });
    return body.result;
}
try {
    await check("authenticated browser sign-in with MFA", async () => {
        await page.goto(origin + "/chat/#fhir");
        await page.locator("#sign-in").click();
        await page.locator("#local-username").fill(account.username);
        await page.locator("#local-password").fill(account.password);
        await page.locator("#local-code").fill(otp(account.totpSecret));
        await page.locator("#local-login").getByRole("button", { name: "Continue", exact: true }).click();
        await expect(page.locator("#account-dialog")).toBeHidden();
        await expect(page.locator("#fhir-new-project")).toBeEnabled();
        signedIn = true;
    });
    const projectId = "browser-dev-" + Date.now().toString(36);
    evidence.projectId = projectId;
    await check("confirmed independent FHIR project with artifact Git destination", async () => {
        await page.locator("#fhir-new-project").click();
        const form = page.locator("#fhir-project-form");
        for (const [name, value] of Object.entries({
            id: projectId,
            name: "Browser Dev Patient",
            canonical: "https://example.org/hyq/dev/browser",
            packageId: "org.hyq.dev.browser",
            publisher: "HYQ development testing",
            repositoryBranch: "feat/modelling-dev",
        }))
            await form.locator(`[name="${name}"]`).fill(value);
        const saved = await operation(
            form.getByRole("button", { name: "Review project changes", exact: true }),
            "fhir_project",
            "create",
            true,
        );
        assert.equal(saved.project.repository.url, "https://github.com/CzarMich/fhir_ig");
        assert.equal(saved.project.fhirVersion, "4.0.1");
        await expect(page.locator("#fhir-context")).toContainText("Browser Dev Patient · FHIR 4.0.1");
    });
    await page
        .locator("#fhir-requirement")
        .fill("Synthetic development patient must explicitly be active and have a birth date.");
    await page.locator("#fhir-base-resource").fill("Patient");
    await page.locator("#fhir-profile-id").fill("browser-dev-patient");
    await page.locator("#fhir-profile-name").fill("BrowserDevelopmentPatient");
    await page.locator("#fhir-profile-title").fill("Browser development Patient");
    await page.locator("#fhir-constraints").fill(
        JSON.stringify([
            {
                path: "Patient.active",
                min: 1,
                fixed: { type: "boolean", value: true },
                source: { kind: "requirement", id: "DEV-REQ-1" },
            },
            { path: "Patient.birthDate", min: 1, source: { kind: "requirement", id: "DEV-REQ-2" } },
        ]),
    );
    await check("author draft FSH after authoritative Patient reuse analysis", async () => {
        const generated = await operation(page.locator("#fhir-generate"), "fhir_profile", "generate");
        assert.match(generated.fsh, /Parent:/);
        await expect(page.locator("#fhir-source")).toHaveValue(/Profile: BrowserDevelopmentPatient/);
    });
    await check("save exact FSH with review and optimistic revision", async () => {
        const saved = await operation(page.locator("#fhir-save"), "fhir_artifact", "save", true);
        assert.ok(saved.revision || saved.artifact?.revision);
    });
    const compiled = await check(
        "actual pinned SUSHI compilation through browser, MCP and private engine",
        async () => {
            const result = await operation(page.locator("#fhir-compile"), "fhir_fsh_compile");
            assert.equal(result.success, true, JSON.stringify(result.diagnostics));
            await expect(page.locator("#fhir-validation-state")).toContainText(
                "Generated resources require FHIR validation",
            );
            return result;
        },
    );
    const profileFile = compiled.files.find((file) => JSON.parse(file.content).resourceType === "StructureDefinition");
    assert.ok(profileFile);
    await page.locator("#fhir-artifact-select").selectOption("draft:" + profileFile.path);
    await expect(page.locator("#fhir-format")).toHaveValue("json");
    const profile = JSON.parse(profileFile.content);
    await check("compiled StructureDefinition inspected and saved with provenance", async () => {
        await operation(page.locator("#fhir-inspect"), "fhir_artifact", "inspect");
        await expect(page.locator("#fhir-artifact-inspector")).toContainText("Patient.birthDate");
        await operation(page.locator("#fhir-save"), "fhir_artifact", "save", true);
    });
    await check("actual HL7 validator checks generated StructureDefinition", async () => {
        const result = await operation(page.locator("#fhir-validate"), "fhir_artifact", "validate");
        assert.equal(result.valid, true, JSON.stringify(result.issues));
        evidence.profileValidation = {
            valid: result.valid,
            status: result.status,
            publicationReady: result.publicationReady,
            counts: result.counts,
        };
    });
    await page.locator("#fhir-example-id").evaluate((element) => {
        element.closest("details").open = true;
    });
    await page.locator("#fhir-example-id").fill("browser-synthetic-patient");
    await page.locator("#fhir-example-values").fill(
        JSON.stringify({
            "Patient.active": true,
            "Patient.birthDate": "2000-01-01",
            "Patient.text": {
                status: "generated",
                div: '<div xmlns="http://www.w3.org/1999/xhtml">Synthetic development patient. Not for clinical use.</div>',
            },
        }),
    );
    await check("generate synthetic example with exact profile lineage", async () => {
        const example = await operation(page.locator("#fhir-example-generate"), "fhir_example_generate");
        assert.equal(example.synthetic, true);
        assert.equal(example.resource.birthDate, "2000-01-01");
        await expect(page.locator("#fhir-validation-profile")).toHaveValue(profile.url);
    });
    await check("valid synthetic example passes profile validation", async () => {
        const result = await operation(page.locator("#fhir-validate"), "fhir_artifact", "validate");
        assert.equal(result.valid, true, JSON.stringify(result.issues));
        assert.equal(result.publicationReady, false);
        evidence.validExample = {
            valid: result.valid,
            status: result.status,
            publicationReady: result.publicationReady,
            counts: result.counts,
        };
    });
    await page.screenshot({ path: resolve(out, "fhir-example-valid.png"), fullPage: true });
    await check("edited invalid example clears evidence and fails fixed value and cardinality validation", async () => {
        const bad = JSON.parse(await page.locator("#fhir-source").inputValue());
        bad.active = false;
        delete bad.birthDate;
        await page.locator("#fhir-source").fill(JSON.stringify(bad, null, 2));
        await expect(page.locator("#fhir-validation-state")).toContainText("Not validated for current editor contents");
        const result = await operation(page.locator("#fhir-validate"), "fhir_artifact", "validate");
        assert.equal(result.valid, false);
        assert.ok(result.counts.errors >= 2);
        evidence.invalidExample = { valid: result.valid, status: result.status, counts: result.counts };
    });
    await page.screenshot({ path: resolve(out, "fhir-example-invalid.png"), fullPage: true });
    await check("saved engineering source survives browser reload", async () => {
        await page.reload();
        await page.locator("#fhir-project").selectOption(projectId);
        await expect(page.locator("#fhir-context")).toContainText("Browser Dev Patient");
        await expect(page.locator("#fhir-artifact-select option")).toContainText(["New draft", "input/fsh/"]);
    });
    await check("separate mappings workspace retains explicit semantic boundary", async () => {
        await page.getByRole("tab", { name: "Cross-standard mappings", exact: true }).click();
        await expect(page.locator("#mapping-project")).toHaveValue(projectId);
        await expect(page.locator("#panel-mappings")).toContainText("matching names do not establish equivalence");
        await page.screenshot({ path: resolve(out, "cross-standard-mappings.png"), fullPage: true });
    });
    evidence.success = true;
} catch (error) {
    evidence.success = false;
    evidence.failure = error.message;
    if (signedIn) await page.screenshot({ path: resolve(out, "failure.png"), fullPage: true }).catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
} finally {
    evidence.completedAt = new Date().toISOString();
    await writeFile(resolve(out, "acceptance.json"), JSON.stringify(evidence, null, 2) + "\n");
    await browser.close();
    console.log(JSON.stringify({ success: evidence.success, checks: evidence.checks.length, evidence: out }));
}
