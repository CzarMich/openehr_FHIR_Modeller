// Local guidance only: this companion makes no network requests or model calls.
const hiddenKey = "modeller.michael.hidden";
const seenKey = "modeller.michael.seen";
const stillKey = "modeller.michael.still";
const preference = (key) => {
    try {
        return localStorage.getItem(key) === "true";
    } catch {
        return false;
    }
};
function remember(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        /* Optional browser preference. */
    }
}
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const tips = {
    prompts: [
        [
            "Give the task a clear finish",
            "State the outcome, source format, target FHIR release/profile, constraints and what needs human review. Ask the agent to report unresolved meanings.",
        ],
        [
            "Use a small, safe example",
            "Provide a schema, a data dictionary and a few synthetic examples. Keep real patient records, identifiers and credentials out of prompts.",
        ],
        [
            "Be precise about your models",
            "Supply the actual StructureDefinitions and applicable openEHR templates, with versions and provenance. Their names alone do not define a mapping.",
        ],
        [
            "Describe the rule, then its exceptions",
            "Explain what each source row means, the expected result, missing-value behaviour, units, time zone and cases that must be quarantined.",
        ],
    ],
    tokens: [
        [
            "Explore a little at a time",
            "Search the relevant schema first, then inspect only the necessary tables or fields. A bounded discovery job is more useful than pasting an entire database catalogue.",
        ],
        [
            "Reuse verified work",
            "Refer to the existing project, model version and source fingerprint. Ask for the specific change you need instead of regenerating unchanged models.",
        ],
        [
            "Ask for the right amount of output",
            "Specify a concise answer, a changed section, or the exact artifact you need. Group related questions and state the acceptance criteria once.",
        ],
        [
            "Keep AI out of the record loop",
            "Use AI to help design and review mappings. Let confirmed deterministic rules process records; that does not require a model call for every record.",
        ],
    ],
};
const root = document.createElement("aside");
root.id = "michael-companion";
root.className = "michael-companion";
root.setAttribute("aria-label", "Michael, optional workspace guidance");
root.innerHTML = `
<section class="michael-panel" id="michael-panel" aria-label="Michael's guidance" hidden>
  <button type="button" class="michael-close" aria-label="Close Michael's suggestion">×</button>
  <p class="michael-kicker">MICHAEL · WORKSPACE GUIDE</p>
  <h2 class="michael-heading"></h2><p class="michael-copy"></p>
  <div class="michael-topics"><button type="button" data-topic="prompts">Prompt tips</button><button type="button" data-topic="tokens">Save tokens</button></div>
  <div class="michael-panel-footer"><span>No AI tokens used</span><button type="button" class="michael-hide">Hide Michael</button></div>
</section>
<button type="button" class="michael-character" aria-label="Ask Michael for prompt and token tips" aria-controls="michael-panel" aria-expanded="false">
<svg viewBox="0 0 100 136" aria-hidden="true" focusable="false">
 <defs><linearGradient id="michael-wire" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f7fbff"/><stop offset=".48" stop-color="#8c9caf"/><stop offset=".72" stop-color="#e7eef5"/><stop offset="1" stop-color="#708296"/></linearGradient></defs>
 <ellipse cx="49" cy="128" rx="29" ry="4" fill="#18394d" opacity=".13"/>
 <g class="michael-body">
  <path d="M74 46V91C74 119 22 119 22 91V28C22 0 68 0 68 28V84C68 104 37 104 37 84V35C37 21 53 21 53 35V78" fill="none" stroke="#435466" stroke-width="10" stroke-linecap="round"/>
  <path d="M74 46V91C74 119 22 119 22 91V28C22 0 68 0 68 28V84C68 104 37 104 37 84V35C37 21 53 21 53 35V78" fill="none" stroke="url(#michael-wire)" stroke-width="6" stroke-linecap="round"/>
  <g class="michael-brow michael-brow-left"><path d="M32 34Q40 28 47 33" fill="none" stroke="#294052" stroke-width="3" stroke-linecap="round"/></g>
  <g class="michael-brow michael-brow-right"><path d="M53 33Q61 28 69 34" fill="none" stroke="#294052" stroke-width="3" stroke-linecap="round"/></g>
  <g class="michael-eye"><ellipse cx="40" cy="44" rx="9" ry="11" fill="white" stroke="#435466" stroke-width="1.5"/><g class="michael-pupil"><ellipse cx="40" cy="45" rx="3.7" ry="5" fill="#173b50"/><circle cx="41" cy="43" r="1.2" fill="white"/></g></g>
  <g class="michael-eye"><ellipse cx="61" cy="44" rx="9" ry="11" fill="white" stroke="#435466" stroke-width="1.5"/><g class="michael-pupil"><ellipse cx="61" cy="45" rx="3.7" ry="5" fill="#173b50"/><circle cx="62" cy="43" r="1.2" fill="white"/></g></g>
  <path d="M42 65Q50 71 58 64" fill="none" stroke="#435466" stroke-width="2.5" stroke-linecap="round"/>
 </g>
 <path class="michael-foot michael-foot-left" d="M32 115L24 123H17" fill="none" stroke="#435466" stroke-width="3" stroke-linecap="round"/>
 <path class="michael-foot michael-foot-right" d="M63 115L70 123H78" fill="none" stroke="#435466" stroke-width="3" stroke-linecap="round"/>
</svg><span class="michael-name">Michael</span></button>`;
document.body.append(root);
const panel = root.querySelector(".michael-panel");
const character = root.querySelector(".michael-character");
root.prepend(character);
let active, idleTimer, resetTimer, greetingTimer, arrivalTimer, frame, previousFocus;
let position = { x: 0, y: 0 },
    topic = "prompts";
const next = { prompts: 0, tokens: 0 };
const motion = () => !reduced.matches && !preference(stillKey);
function closePanel() {
    panel.hidden = true;
    character.setAttribute("aria-expanded", "false");
    clearTimeout(greetingTimer);
}
function openPanel(title, copy) {
    root.querySelector(".michael-heading").textContent = title;
    root.querySelector(".michael-copy").textContent = copy;
    panel.hidden = false;
    character.setAttribute("aria-expanded", "true");
    clearTimeout(greetingTimer);
}
function showTip(category) {
    topic = category;
    const entries = tips[category],
        entry = entries[next[category]++ % entries.length];
    openPanel(entry[0], entry[1]);
}
function idle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
        () => {
            if (!root.hidden && !document.hidden && motion()) {
                const expression = Math.random();
                root.classList.add(
                    expression < 0.1 ? "michael-looking" : expression < 0.35 ? "michael-curious" : "michael-blink",
                );
                resetTimer = setTimeout(
                    () => root.classList.remove("michael-curious", "michael-blink", "michael-looking"),
                    1100,
                );
            }
            if (!root.hidden) idle();
        },
        12000 + Math.random() * 14000,
    );
}
function stopArrival() {
    clearTimeout(arrivalTimer);
    root.classList.remove("michael-arriving");
}
function greet() {
    if (root.hidden || preference(seenKey)) return;
    remember(seenKey, true);
    openPanel("Hi, I’m Michael.", "I’m here to help you write clear prompts and save AI tokens—whenever you need me.");
    // No focus changes or repeated interruptions; the greeting quietly closes itself.
    greetingTimer = setTimeout(closePanel, 12000);
}
function show() {
    active?.abort();
    active = new AbortController();
    root.hidden = false;
    remember(hiddenKey, false);
    if (motion()) {
        document.addEventListener(
            "pointermove",
            (event) => {
                position = { x: event.clientX, y: event.clientY };
                if (frame || document.hidden) return;
                frame = requestAnimationFrame(() => {
                    frame = null;
                    const box = character.getBoundingClientRect(),
                        x = box.left + box.width / 2,
                        y = box.top + box.height * 0.35;
                    const dx = position.x - x,
                        dy = position.y - y,
                        distance = Math.max(1, Math.hypot(dx, dy));
                    root.style.setProperty("--michael-gaze-x", `${((dx / distance) * 3).toFixed(2)}px`);
                    root.style.setProperty("--michael-gaze-y", `${((dy / distance) * 2.5).toFixed(2)}px`);
                });
            },
            { passive: true, signal: active.signal },
        );
    }
    clearTimeout(idleTimer);
    if (motion()) idle();
    else {
        root.classList.remove("michael-curious", "michael-blink", "michael-looking");
        root.style.setProperty("--michael-gaze-x", "0px");
        root.style.setProperty("--michael-gaze-y", "0px");
    }
}
function hide() {
    closePanel();
    stopArrival();
    active?.abort();
    clearTimeout(idleTimer);
    clearTimeout(resetTimer);
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    root.hidden = true;
    remember(hiddenKey, true);
    remember(seenKey, true);
    if (previousFocus?.isConnected && !previousFocus.closest("[hidden]")) previousFocus.focus({ preventScroll: true });
}
root.addEventListener("focusin", (event) => {
    clearTimeout(greetingTimer);
    if (event.relatedTarget && !root.contains(event.relatedTarget)) previousFocus = event.relatedTarget;
});
root.addEventListener("pointerenter", () => clearTimeout(greetingTimer), { passive: true });
character.addEventListener("click", () => {
    stopArrival();
    if (panel.hidden) showTip(topic);
    else closePanel();
});
root.querySelector(".michael-close").addEventListener("click", () => {
    closePanel();
    character.focus();
});
root.querySelector(".michael-hide").addEventListener("click", hide);
for (const button of root.querySelectorAll("[data-topic]"))
    button.addEventListener("click", () => showTip(button.dataset.topic));
root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closePanel();
        character.focus();
        event.stopPropagation();
    }
});
for (const button of document.querySelectorAll("[data-show-michael]"))
    button.addEventListener("click", () => {
        stopArrival();
        remember(seenKey, true);
        show();
        showTip("tokens");
        character.focus();
    });
for (const checkbox of document.querySelectorAll("[data-michael-still]")) {
    checkbox.checked = preference(stillKey);
    checkbox.addEventListener("change", () => {
        remember(stillKey, checkbox.checked);
        stopArrival();
        root.classList.remove("michael-curious", "michael-blink", "michael-looking");
        root.style.setProperty("--michael-gaze-x", "0px");
        root.style.setProperty("--michael-gaze-y", "0px");
        if (!root.hidden) show();
    });
}
reduced.addEventListener("change", () => {
    stopArrival();
    if (!root.hidden) show();
});
if (preference(hiddenKey)) root.hidden = true;
else {
    show();
    if (!preference(seenKey) && motion() && innerWidth >= 720) {
        root.classList.add("michael-arriving");
        arrivalTimer = setTimeout(() => {
            stopArrival();
            greet();
        }, 4400);
    } else greet();
}
