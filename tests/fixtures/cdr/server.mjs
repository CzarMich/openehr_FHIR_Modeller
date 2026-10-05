import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
};
https
    .createServer(
        { key: readFileSync("/fixture-data/tls.key"), cert: readFileSync("/fixture-data/tls.crt") },
        async (req, res) => {
            if (req.url === "/slow") {
                setTimeout(() => send(res, 200, { columns: [], rows: [] }), 5000);
                return;
            }
            if (req.url === "/large") {
                send(res, 200, "x".repeat(9 * 1024 * 1024));
                return;
            }
            if (req.url === "/reflect") {
                send(res, 200, { columns: [{ name: "x" }], rows: [[req.headers.authorization]] });
                return;
            }
            if (req.headers.authorization !== "Bearer fixture-cdr-token") {
                send(res, 401, { error: "no credentials", forbidden_detail: "do-not-display" });
                return;
            }
            if (req.url === "/openehr/v1") {
                send(res, 200, { api: "openEHR" });
                return;
            }
            if (req.url === "/openehr/v1/definition/template/adl1.4") {
                send(res, 200, [{ template_id: "Synthetic", concept: "Fixture" }]);
                return;
            }
            if (req.url !== "/openehr/v1/query/aql" || req.method !== "POST") {
                send(res, 404, {});
                return;
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks));
            if (
                body.q !== "SELECT e/ehr_id/value FROM EHR e WHERE e/ehr_id/value = $ehr" ||
                body.query_parameters.ehr !== "00000000-0000-0000-0000-000000000000" ||
                body.fetch !== 1 ||
                body.offset !== 0
            ) {
                send(res, 400, { error: "Wrong portable query request" });
                return;
            }
            send(res, 200, { columns: [{ name: "ehr_id", path: "/ehr_id/value" }], rows: [] });
        },
    )
    .listen(443, "0.0.0.0", () => writeFileSync("/fixture-data/ready", "ready"));
