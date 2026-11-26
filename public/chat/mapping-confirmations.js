"use strict";
const field = (name) => document.getElementById("mapping-confirmation-" + name);
let session,
    selected,
    busy = false,
    generation = 0;
const notice = (message) => {
    field("notice").textContent = message;
};
function clear() {
    selected = null;
    field("detail").hidden = true;
    field("models").replaceChildren();
    field("reviewed").checked = false;
    field("comment").value = "";
}
async function request(subject, input) {
    const response = await fetch("/chat/api/reviews/confirmations/" + subject, {
        method: input ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" },
        body: input ? JSON.stringify(input) : undefined,
        signal: AbortSignal.timeout(60000),
    });
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The confirmation request failed.");
    return data;
}
function render(view) {
    selected = view;
    field("state").textContent =
        view.state + (view.current ? " · Current model revisions" : " · Model changed: prepare a new request");
    field("models").replaceChildren();
    for (const item of view.items) {
        const details = document.createElement("details"),
            summary = document.createElement("summary"),
            pins = document.createElement("pre"),
            content = document.createElement("pre");
        summary.textContent = item.pin.standard + " · " + item.pin.path + " · " + item.pin.origin;
        pins.textContent = JSON.stringify(item.pin, null, 2);
        content.textContent = item.content;
        details.append(summary, pins, content);
        field("models").append(details);
    }
    field("reviewed").checked = false;
    field("comment").value = "";
    field("detail").hidden = false;
    field("confirm").disabled = !view.current;
}
async function run(action) {
    if (busy) return;
    busy = true;
    const identity = generation;
    field("load").disabled = true;
    field("confirm").disabled = true;
    field("revoke").disabled = true;
    try {
        if (!session?.authenticated || !session?.reviewEnabled)
            throw new Error("Sign in with model review access to continue.");
        const result = await action();
        if (identity === generation && result) render(result);
    } catch (error) {
        if (identity === generation) notice(error.message);
    } finally {
        busy = false;
        field("load").disabled = !session?.authenticated;
        field("confirm").disabled = !selected?.current;
        field("revoke").disabled = !selected;
    }
}
field("load").onclick = () =>
    run(async () => {
        clear();
        notice("");
        const subject = field("subject").value.trim();
        if (!/^[a-f0-9]{64}$/.test(subject))
            throw new Error("Paste the exact confirmation request identifier returned by the agent.");
        return request(subject);
    });
for (const [button, decision] of [
    ["confirm", "CONFIRMED"],
    ["revoke", "REVOKED"],
]) {
    field(button).onclick = () =>
        run(async () => {
            if (!selected || !field("reviewed").checked || !field("comment").value.trim())
                throw new Error("Inspect both models, check the acknowledgement and enter a decision comment.");
            const result = await request(selected.subject, {
                decision,
                expectedSequence: selected.sequence,
                comment: field("comment").value,
            });
            notice(
                decision === "CONFIRMED"
                    ? "Your confirmation was recorded for these exact model revisions."
                    : "This model selection was revoked.",
            );
            return result;
        });
}
document.addEventListener("workspace:session", (event) => {
    generation++;
    session = event.detail;
    clear();
    notice("");
    field("load").disabled = !session?.authenticated;
});
document.addEventListener("workspace:session-expired", () => {
    generation++;
    session = null;
    clear();
    notice("Sign in again before confirming models.");
});
document.addEventListener("workspace:project", () => {
    generation++;
    clear();
    field("subject").value = "";
    notice("");
});
