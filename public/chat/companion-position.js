// Browser-local positioning only. No network, patient data or model calls.
const positionKey = "modeller.leticia.position";
export function attachCompanionPosition({ root, character, panel, beforeMove }) {
    let saved = null,
        drag = null,
        pending = null,
        frame = null,
        suppressClick = false;
    try {
        const value = JSON.parse(localStorage.getItem(positionKey));
        if (
            value?.version === 1 &&
            Number.isFinite(value.x) &&
            Number.isFinite(value.y) &&
            value.x >= 0 &&
            value.x <= 1 &&
            value.y >= 0 &&
            value.y <= 1
        )
            saved = { x: value.x, y: value.y };
    } catch {
        /* Position preferences are optional. */
    }
    const limits = () => ({
        x: Math.max(8, innerWidth - character.offsetWidth - 8),
        y: Math.max(8, innerHeight - character.offsetHeight - 8),
    });
    function positionPanel() {
        if (panel.hidden || root.hidden) return;
        panel.style.bottom = "auto";
        panel.style.right = "auto";
        panel.style.maxHeight = `${Math.max(40, innerHeight - 16)}px`;
        const box = character.getBoundingClientRect();
        const width = panel.offsetWidth,
            height = panel.offsetHeight;
        const x = Math.max(8, Math.min(innerWidth - width - 8, box.right - width));
        const above = box.top - height - 12;
        const y = above >= 8 ? above : Math.max(8, Math.min(innerHeight - height - 8, box.bottom + 12));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
    }
    function place(x, y) {
        const limit = limits();
        x = Math.max(8, Math.min(limit.x, x));
        y = Math.max(8, Math.min(limit.y, y));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.right = "auto";
        root.style.bottom = "auto";
        positionPanel();
        return { x, y };
    }
    function rememberPosition() {
        const box = character.getBoundingClientRect();
        saved = {
            x: Math.max(0, Math.min(1, box.left / Math.max(1, innerWidth - character.offsetWidth))),
            y: Math.max(0, Math.min(1, box.top / Math.max(1, innerHeight - character.offsetHeight))),
        };
        try {
            localStorage.setItem(positionKey, JSON.stringify({ version: 1, ...saved }));
        } catch {
            /* Keep this session's position. */
        }
    }
    function clearInlinePosition() {
        for (const property of ["left", "top", "right", "bottom"]) root.style.removeProperty(property);
    }
    function refresh() {
        if (root.hidden) return;
        if (saved)
            place(
                saved.x * Math.max(1, innerWidth - character.offsetWidth),
                saved.y * Math.max(1, innerHeight - character.offsetHeight),
            );
        else if (root.style.left) {
            const box = character.getBoundingClientRect();
            place(box.left, box.top);
        }
        positionPanel();
    }
    function flush() {
        if (frame) cancelAnimationFrame(frame);
        frame = null;
        if (pending) {
            place(pending.x, pending.y);
            pending = null;
        }
    }
    function finish(event) {
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        flush();
        const previous = drag;
        drag = null;
        root.classList.remove("michael-dragging");
        if (character.hasPointerCapture(previous.pointerId)) character.releasePointerCapture(previous.pointerId);
        if (previous.moved) {
            rememberPosition();
            suppressClick = true;
            setTimeout(() => {
                suppressClick = false;
            }, 0);
        } else if (!saved) clearInlinePosition();
        positionPanel();
    }
    character.addEventListener("pointerdown", (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        const box = character.getBoundingClientRect();
        beforeMove();
        place(box.left, box.top);
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: box.left,
            y: box.top,
            moved: false,
        };
        character.setPointerCapture(event.pointerId);
    });
    character.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.startX,
            dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        root.classList.add("michael-dragging");
        pending = { x: drag.x + dx, y: drag.y + dy };
        if (!frame) frame = requestAnimationFrame(flush);
        event.preventDefault();
    });
    character.addEventListener("pointerup", finish);
    character.addEventListener("pointercancel", finish);
    character.addEventListener("lostpointercapture", finish);
    // Capturing keeps a completed drag from also opening or closing the tips.
    character.addEventListener(
        "click",
        (event) => {
            if (!suppressClick) return;
            suppressClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        },
        true,
    );
    character.addEventListener("keydown", (event) => {
        const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!event.altKey || !movement) return;
        event.preventDefault();
        event.stopPropagation();
        beforeMove();
        const box = character.getBoundingClientRect(),
            step = event.shiftKey ? 64 : 16;
        place(box.left + movement[0] * step, box.top + movement[1] * step);
        rememberPosition();
    });
    window.addEventListener("resize", refresh);
    new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["data-section"] });
    refresh();
    return {
        get hasSavedPosition() {
            return saved !== null;
        },
        refresh,
        positionPanel,
        cancel: () => finish(),
        reset() {
            finish();
            beforeMove();
            saved = null;
            try {
                localStorage.removeItem(positionKey);
            } catch {
                /* Optional preference. */
            }
            clearInlinePosition();
            positionPanel();
            character.focus();
        },
    };
}
