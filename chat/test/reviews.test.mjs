import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { ReviewClient } from "../src/reviews.mjs";
import { loadConfig } from "../src/config.mjs";

function config() {
    return loadConfig({
        CHAT_REVIEW_ENABLED: "true",
        CHAT_PUBLIC_URL: "https://models.example",
        CHAT_OIDC_ISSUER: "https://identity.example",
        CHAT_OIDC_CLIENT_ID: "browser",
        CHAT_OIDC_CLIENT_SECRET: "fixture-secret",
        CHAT_REVIEW_SIGNING_KEY: "a".repeat(64),
    });
}
function session() {
    return {
        reviewIdentity: {
            issuer: "https://identity.example",
            subject: "alice",
            tenant: "https://identity.example",
            roles: ["modelling-reviewer"],
            projectScopes: ["project:alpha:read"],
            started: Math.floor(Date.now() / 1000),
        },
    };
}

test("review-only configuration needs no chat model credential or enabled chat", () => {
    const c = config();
    assert.equal(c.enabled, false);
    assert.equal(c.reviewEnabled, true);
    assert.throws(() => loadConfig({ CHAT_REVIEW_ENABLED: "true" }), /OIDC/);
    assert.throws(
        () =>
            loadConfig({
                ...process.env,
                CHAT_REVIEW_ENABLED: "true",
                CHAT_OIDC_ISSUER: "https://identity.example",
                CHAT_OIDC_CLIENT_ID: "browser",
                CHAT_OIDC_CLIENT_SECRET: "secret",
                CHAT_REVIEW_SIGNING_KEY: "weak",
            }),
        /signing key/,
    );
});

test("browser assertions bind exact request and verified session claims with a separate key purpose", async () => {
    let captured;
    const c = config(),
        client = new ReviewClient(c, async (url, options) => {
            captured = { url, options };
            return new Response('{"state":"REVIEWED"}', { headers: { "Content-Type": "application/json" } });
        });
    const target = "/api/v1/reviews/" + "b".repeat(64) + "/transitions",
        input = { state: "REVIEWED", expectedSequence: 3, comment: "Reviewed source." };
    assert.equal((await client.request(session(), "POST", target, input)).state, "REVIEWED");
    const { options, url } = captured;
    assert.equal(url.origin, "http://ingress:8343");
    assert.equal(options.redirect, "error");
    assert.equal(options.body, JSON.stringify(input));
    const [header, payload, signature] = options.headers.Authorization.slice(7).split(".");
    const decode = (value) => JSON.parse(Buffer.from(value, "base64url"));
    assert.deepEqual(decode(header), { alg: "HS256", typ: "openehr-review+jwt", kid: "active" });
    const claims = decode(payload);
    assert.equal(claims.sub, "alice");
    assert.equal(claims.identity_method, "interactive_oidc");
    assert.equal(claims.aud, "openehr-modelling-review");
    assert.deepEqual(claims.roles, ["modelling-reviewer"]);
    assert.deepEqual(claims.project_scopes, ["project:alpha:read"]);
    assert.equal(claims.target, target);
    assert.equal(claims.method, "POST");
    assert.equal(claims.body_sha256, createHash("sha256").update(options.body).digest("hex"));
    assert.equal(
        signature,
        createHmac("sha256", c.reviewSigningKey)
            .update(header + "." + payload)
            .digest("base64url"),
    );
    assert.equal(claims.exp - claims.iat, 60);
    assert.match(claims.jti, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(options).includes(c.reviewSigningKey), false);
    assert.equal(Object.hasOwn(options.headers, "Cookie"), false);
    assert.equal(Object.hasOwn(options.headers, "X-API-Key"), false);
});

test("native local sessions attest a distinct configured issuer and authentication method", async () => {
    const c = loadConfig({
        CHAT_REVIEW_ENABLED: "true",
        CHAT_LOCAL_IDENTITY_ENABLED: "true",
        CHAT_LOCAL_IDENTITY_ISSUER: "https://models.example/identity/local",
        CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY: "ab".repeat(32),
        CHAT_PUBLIC_URL: "https://models.example",
        CHAT_REVIEW_SIGNING_KEY: "a".repeat(64),
    });
    let claims;
    const client = new ReviewClient(c, async (_url, options) => {
        const [, payload] = options.headers.Authorization.slice(7).split(".");
        claims = JSON.parse(Buffer.from(payload, "base64url"));
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });
    await client.request(
        {
            reviewIdentity: {
                issuer: c.localIssuer,
                subject: "local-user-id",
                tenant: c.localIssuer,
                roles: ["modelling-reviewer"],
                projectScopes: [],
                started: Math.floor(Date.now() / 1000),
                method: "interactive_local",
            },
        },
        "GET",
        "/api/v1/reviews?project=default",
    );
    assert.equal(claims.identity_issuer, c.localIssuer);
    assert.equal(claims.identity_method, "interactive_local");
    assert.equal(claims.tenant, c.localIssuer);
});

test("expired or missing interactive session never creates an assertion", async () => {
    const client = new ReviewClient(config(), async () => {
        throw new Error("Must not send");
    });
    await assert.rejects(() => client.request({}, "GET", "/api/v1/reviews?project=default"), /Sign in again/);
    const old = session();
    old.reviewIdentity.started -= 3601;
    await assert.rejects(() => client.request(old, "GET", "/api/v1/reviews?project=default"), /Sign in again/);
});

test("governance browsing carries the chat session while decisions retain recent-sign-in checks", async () => {
    let requests = 0;
    const client = new ReviewClient(config(), async () => {
        requests++;
        return new Response('{"items":[]}');
    });
    const active = session();
    active.reviewIdentity.started -= 1800;
    assert.deepEqual(await client.request(active, "GET", "/api/v1/reviews?project=default"), { items: [] });
    await assert.rejects(
        () => client.request(active, "POST", "/api/v1/reviews/" + "b".repeat(64) + "/transitions", {}),
        /Sign in again/,
    );
    assert.equal(requests, 1);
});

test("review response limits, upstream failure redaction and request purpose remain bounded", async () => {
    const fail = new ReviewClient(
        config(),
        async () => new Response('{"error":{"code":"SECRET upstream body"}}', { status: 500 }),
    );
    await assert.rejects(
        () => fail.request(session(), "GET", "/api/v1/reviews?project=default"),
        (error) => error.status === 502 && !error.message.includes("SECRET"),
    );
    await assert.rejects(() => fail.request(session(), "GET", "/mcp"), /Invalid review operation/);
    const large = new ReviewClient(config(), async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)));
    await assert.rejects(() => large.request(session(), "GET", "/api/v1/reviews?project=default"), /exceeds the limit/);
});
