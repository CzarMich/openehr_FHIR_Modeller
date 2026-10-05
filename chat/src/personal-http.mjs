import https from "node:https";
import { lookup } from "node:dns";
import ipaddr from "ipaddr.js";

export const problem = (message, status = 400) => Object.assign(new Error(message), { status, userSafe: true });

export function httpsUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw problem("Enter a valid HTTPS URL.");
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.port && url.port !== "443") ||
        value.length > 500
    )
        throw problem("Use an HTTPS URL without credentials, a query, or a custom port.");
    return url;
}

export function publicAddress(address) {
    try {
        return ipaddr.process(address).range() === "unicast";
    } catch {
        return false;
    }
}

// The checked DNS address is the address used by the socket, including IPv6.
// Redirects are never followed and enterprise credentials never enter this client.
export function personalRequest(
    url,
    {
        method = "GET",
        token = "",
        body,
        signal,
        allowedHosts = [],
        accept = "application/json",
        timeoutMs = 20000,
    } = {},
) {
    const target = new URL(url);
    httpsUrl(target.origin + target.pathname);
    const explicitlyAllowed = allowedHosts.includes(target.hostname);
    if (
        ipaddr.isValid(target.hostname.replace(/^\[|\]$/g, "")) &&
        !explicitlyAllowed &&
        !publicAddress(target.hostname.replace(/^\[|\]$/g, ""))
    )
        throw problem("This network address is not available for personal connections.");
    return new Promise((resolve, reject) => {
        const request = https.request(
            target,
            {
                method,
                signal: AbortSignal.any([
                    signal || new AbortController().signal,
                    AbortSignal.timeout(Math.min(60000, Math.max(1000, timeoutMs))),
                ]),
                agent: false,
                lookup: (host, options, callback) =>
                    lookup(host, { all: true }, (error, addresses) => {
                        if (
                            error ||
                            !addresses?.length ||
                            (!explicitlyAllowed && addresses.some((a) => !publicAddress(a.address)))
                        )
                            return callback(problem("This network address is not available for personal connections."));
                        callback(null, options.all ? addresses : addresses[0].address, addresses[0].family);
                    }),
                headers: {
                    Accept: accept,
                    "User-Agent": "openehr-modelling-workspace",
                    ...(token ? { Authorization: "Bearer " + token } : {}),
                    ...(body ? { "Content-Type": "application/json" } : {}),
                },
            },
            (response) => {
                const chunks = [];
                let size = 0;
                response.on("data", (chunk) => {
                    size += chunk.length;
                    if (size > 4 * 1024 * 1024) request.destroy(problem("The remote response is too large.", 413));
                    else chunks.push(chunk);
                });
                response.on("error", () =>
                    reject(problem("The personal connection could not complete the request.", 503)),
                );
                response.on("end", () =>
                    resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
                );
            },
        );
        request.on("error", () =>
            reject(
                problem("The personal connection could not complete the request. Check the URL and access token.", 503),
            ),
        );
        request.end(body ? JSON.stringify(body) : undefined);
    });
}
