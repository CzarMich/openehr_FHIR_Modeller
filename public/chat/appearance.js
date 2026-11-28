// Restore only the visual preference before stylesheet paint; no identity or patient data.
try {
    const preference = JSON.parse(localStorage.getItem("modeller.workspace.layout.v1") || "{}");
    document.documentElement.dataset.theme = preference.theme === "dark" ? "dark" : "light";
} catch {
    document.documentElement.dataset.theme = "light";
}
