export const USER_ROLES = Object.freeze(["modelling-modeller"]);
export const ADMINISTRATOR_ROLES = Object.freeze([
    "modelling-administrator",
    "modelling-modeller",
    "modelling-reviewer",
    "modelling-approver",
    "modelling-publisher",
]);
export function userType(roles) {
    return roles.includes("modelling-administrator") ? "administrator" : "user";
}
export function rolesForType(type) {
    if (type === "user") return [...USER_ROLES];
    if (type === "administrator") return [...ADMINISTRATOR_ROLES];
    throw Object.assign(new Error("Choose Administrator or User."), { status: 400 });
}
export function oidcRoles(roles, scheme = "governance") {
    if (
        !Array.isArray(roles) ||
        roles.length > 100 ||
        roles.some((role) => typeof role !== "string" || role.length > 200)
    )
        throw Object.assign(new Error("Organisation role claims are invalid."), { status: 403 });
    if (scheme === "governance") return [...roles];
    if (scheme !== "platform") throw new Error("Invalid organisation role scheme.");
    if (roles.includes("platform-admin")) return [...ADMINISTRATOR_ROLES];
    if (roles.includes("platform-user")) return [...USER_ROLES];
    throw Object.assign(new Error("An administrator must assign a platform account type before sign-in."), {
        status: 403,
    });
}
