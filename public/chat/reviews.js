"use strict";
const $ = (id) => document.getElementById("review-" + id);
let session,
    selected,
    pending,
    busy = false,
    offset = 0,
    hasMore = false;
const labels = {
    REVIEW_REQUESTED: "Request independent review",
    DRAFT: "Reopen as draft",
    REVIEWED: "Record completed review",
    CHANGES_REQUESTED: "Request changes",
    APPROVED: "Approve exact revision",
    PUBLISHED: "Publish approved revision",
    DEPRECATED: "Deprecate revision",
};
function notice(message) {
    $("notice").textContent = message || "";
    $("notice").hidden = !message;
}
async function api(path, input) {
    const response = await fetch(path, {
        method: input === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" },
        body: input === undefined ? undefined : JSON.stringify(input),
    });
    const data = await response.json();
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    if (!response.ok) throw new Error(data.error || "The review request failed.");
    return data;
}
async function run(action) {
    if (busy) return;
    busy = true;
    notice("");
    for (const button of document.querySelectorAll("#panel-governance button")) button.disabled = true;
    try {
        await action();
    } catch (error) {
        notice(error.message);
    } finally {
        busy = false;
        for (const button of document.querySelectorAll("#panel-governance button")) button.disabled = false;
        $("load").disabled = !session?.authenticated || !session?.reviewEnabled;
        $("review-decision").disabled = !selected?.available_transitions?.length;
        $("confirm-decision").disabled = !pending;
        $("previous").disabled = offset === 0;
        $("next").disabled = !hasMore;
    }
}
async function load() {
    const result = await api(
        "/chat/api/reviews?project=" + encodeURIComponent($("project").value.trim()) + "&offset=" + offset,
    );
    hasMore = result.has_more_possible;
    $("reviews").replaceChildren();
    if (!result.items.length) {
        const p = document.createElement("p");
        p.textContent = "No governed revisions in this project. Prepare a review through the modelling tools.";
        $("reviews").append(p);
    }
    for (const item of result.items) {
        const button = document.createElement("button");
        button.className = "review-item";
        button.textContent = item.source.path + " · " + item.state;
        button.onclick = () => run(() => open(item.subject));
        $("reviews").append(button);
    }
}
async function open(subject) {
    selected = await api("/chat/api/reviews/" + subject);
    pending = null;
    $("confirmation").hidden = true;
    $("detail").hidden = false;
    $("detail").setAttribute("tabindex", "-1");
    $("detail").focus({ preventScroll: true });
    $("title").textContent = selected.source.path;
    $("state").textContent = selected.state;
    $("identity").textContent =
        "Revision: " +
        selected.source.revision +
        " · SHA-256: " +
        selected.source.sha256 +
        " · Audit sequence: " +
        selected.sequence;
    $("source-status").textContent = selected.current_source
        ? "This evidence refers to the current source revision."
        : "This source is no longer current, or its current state could not be verified. It cannot be approved or published as the current model.";
    $("source").textContent = selected.content;
    $("validation-status").textContent = selected.validation?.release_eligible
        ? "The installed pipeline reports release eligibility. Clinical approval still requires an independent human decision."
        : "Validation is incomplete or unavailable. Clinical approval and publication are blocked.";
    $("validation").textContent = JSON.stringify(selected.validation, null, 2);
    $("audit").replaceChildren();
    for (const event of selected.events) {
        const li = document.createElement("li");
        li.textContent =
            event.timestamp +
            " · " +
            event.actor.id +
            " · " +
            (event.actor.human ? "human" : "service / agent") +
            " · " +
            (event.previous_state || "New") +
            " → " +
            event.new_state +
            ": " +
            event.comment;
        $("audit").append(li);
    }
    $("decision").replaceChildren();
    for (const value of selected.available_transitions) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = labels[value] || value;
        $("decision").append(option);
    }
    $("action-note").textContent = selected.available_transitions.length
        ? "Actions depend on your assigned role, authorship and validation evidence."
        : "No lifecycle action is currently available for your role and this revision.";
    $("comment").value = "";
}
$("project-form").onsubmit = (event) => {
    event.preventDefault();
    offset = 0;
    selected = null;
    pending = null;
    $("detail").hidden = true;
    $("confirmation").hidden = true;
    run(load);
};
$("decision-form").onsubmit = (event) => {
    event.preventDefault();
    if (!selected || !selected.available_transitions.includes($("decision").value) || !$("comment").value.trim())
        return;
    pending = {
        subject: selected.subject,
        input: {
            state: $("decision").value,
            expectedSequence: selected.sequence,
            comment: $("comment").value.trim(),
            validationDigest: selected.validation_digest,
        },
    };
    $("confirmation-details").textContent = JSON.stringify(
        {
            project: selected.source.project,
            path: selected.source.path,
            revision: selected.source.revision,
            sha256: selected.source.sha256,
            ...pending.input,
        },
        null,
        2,
    );
    $("confirmation").hidden = false;
    $("confirm-decision").disabled = false;
    $("confirmation").scrollIntoView({ behavior: "smooth", block: "nearest" });
};
$("cancel-decision").onclick = () => {
    pending = null;
    $("confirmation").hidden = true;
};
$("confirm-decision").onclick = () =>
    run(async () => {
        if (!pending) return;
        const request = pending;
        pending = null;
        $("confirmation").hidden = true;
        await api("/chat/api/reviews/" + request.subject + "/transitions", request.input);
        await open(request.subject);
        await load();
        notice("Your decision was recorded for the displayed revision.");
    });
$("signout").onclick = () =>
    run(async () => {
        await api("/chat/auth/logout", {});
        location.reload();
    });
async function initializeReview() {
    await run(async () => {
        session = await api("/chat/api/session");
        $("signed-in-user").textContent = session.authenticated ? "Signed in as " + session.user.name : "";
        $("signin").hidden = !session.authenticated || !session.oidcEnabled;
        $("signin").textContent = "Verify review access";
        $("signout").hidden = true; // The workspace header owns sign-out.
        if (!session.reviewEnabled) notice("Model review is not configured on this deployment.");
        else if (session.authenticated) await load();
    });
}
document.addEventListener("workspace:governance", () => {
    if (!session) initializeReview();
});
document.addEventListener("workspace:project", (event) => {
    $("project").value = event.detail.project;
    offset = 0;
    selected = null;
    pending = null;
    $("detail").hidden = true;
    $("confirmation").hidden = true;
    if (session?.authenticated) run(load);
});

$("previous").onclick = () =>
    run(async () => {
        offset = Math.max(0, offset - 25);
        await load();
    });
$("next").onclick = () =>
    run(async () => {
        offset += 25;
        await load();
    });
