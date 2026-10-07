import assert from "node:assert/strict";
globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    assert.equal(options.redirect, "error");
    assert(new URL(url).hostname.endsWith(".environment.api.powerplatform.com"));
    const body = JSON.parse(options.body);
    let activities;
    if (Object.hasOwn(body, "emitStartConversationEvent")) {
        assert.equal(body.emitStartConversationEvent, true, "The setup topic must register the workspace tool");
        activities = [];
    } else if (body.activity.type === "message")
        activities = [
            {
                type: "event",
                name: "OpenEhrWorkspace",
                replyToId: "native-call",
                value: { operation: "call", tool: "ckm_sources", argumentsJson: "{}" },
            },
        ];
    else {
        assert.equal(body.activity.replyToId, "native-call");
        assert.deepEqual(JSON.parse(body.activity.value.resultJson), { fixture: "verified" });
        activities = [{ type: "message", id: "message-1", text: "Verified SDK response" }];
    }
    return new Response(
        activities.map((activity) => "event: activity\ndata: " + JSON.stringify(activity) + "\n\n").join("") +
            "event: end\ndata: done\n\n",
        { headers: { "Content-Type": "text/event-stream", "x-ms-conversationid": "fixture-conversation" } },
    );
};
await import("../src/copilot-worker.mjs");
