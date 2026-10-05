import https from "node:https";
import fs from "node:fs";

// Isolated synthetic credentials only. Never use deployment accounts in this fixture.
const root = "/fixture-data";
const events = [];
const credentialHeaders = ["authorization", "jsessionid", "x-ckm-key"];
function expected(source) {
    return {
        basic: ["authorization", "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64")],
        bearer: ["authorization", "Bearer fixture-token"],
        session: ["jsessionid", fs.readFileSync(root + "/session.secret", "utf8").trim()],
        "api-key": ["x-ckm-key", "fixture-key"],
        denied: ["authorization", "Bearer deliberately-different"],
        redirect: ["authorization", "Bearer fixture-redirect"],
    }[source];
}
const server = https.createServer({ key: fs.readFileSync(root + "/tls.key"), cert: fs.readFileSync(root + "/tls.crt") }, (request, response) => {
    const url = new URL(request.url, "https://ckm-fixture");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/stats") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ events }));
        return;
    }
    const source = parts[0];
    const credential = expected(source);
    const unexpected = credentialHeaders.some((header) => request.headers[header] && header !== credential?.[0]);
    const authenticated = !unexpected && (!credential || request.headers[credential[0]] === credential[1]);
    events.push({ source, path: url.pathname, authenticated, unexpected, collector: source === "collector" });
    if (!authenticated || source === "collector") {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end('{"error":"Synthetic fixture authentication failed"}');
        return;
    }
    if (source === "redirect") {
        response.writeHead(302, { Location: "https://ckm-fixture/collector", "Content-Type": "application/json" });
        response.end("[]");
        return;
    }
    if (parts[1] !== "v1" || !["archetypes", "templates"].includes(parts[2])) {
        response.writeHead(404);
        response.end();
        return;
    }
    if (parts.length === 3) {
        response.writeHead(200, { "Content-Type": "application/json", "X-Total-Count": "3" });
        response.end(JSON.stringify([{ cid: "1.2.3", resourceMainId: "openEHR-EHR-OBSERVATION.fixture.v1", resourceMainDisplayName: "Synthetic fixture", projectName: "Synthetic fixtures", status: "PUBLISHED", revision: source, versionAsset: source }]));
    } else if (parts[3] === "citeable-identifier") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("1.2.3");
    } else {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(parts[2] === "archetypes" ? `archetype (adl_version=1.4)\nopenEHR-EHR-OBSERVATION.fixture.v1\n-- Synthetic source ${source}\n` : `<template xmlns="openEHR/v1/Template"><id>fixture</id><name>Synthetic ${source}</name><definition archetype_id="openEHR-EHR-COMPOSITION.fixture.v1"/></template>`);
    }
});
server.listen(443, "0.0.0.0", () => fs.writeFileSync(root + "/ready", "ready"));
