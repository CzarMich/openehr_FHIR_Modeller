import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createApplication } from "./src/server.mjs";
import { loadConfig } from "./src/config.mjs";
const config = loadConfig();
if (config.enabled) {
    if (spawnSync(config.codexBinary, ["--version"], { stdio: "ignore", timeout: 10000 }).status !== 0)
        throw new Error("Conversational chat requires the chat image target; model review uses the reviews target.");
}
if (config.enabled || config.reviewEnabled) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (existsSync("/run/secrets/dev-ca.crt")) {
        const path = config.dataDir + "/ca-bundle.pem";
        writeFileSync(
            path,
            readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8") +
                "\n" +
                readFileSync("/run/secrets/dev-ca.crt", "utf8"),
            { mode: 0o600 },
        );
        process.env.SSL_CERT_FILE = path;
    }
}
createApplication(config).listen(config.port, "0.0.0.0", () =>
    console.log(JSON.stringify({ event: "chat_started", enabled: config.enabled })),
);
