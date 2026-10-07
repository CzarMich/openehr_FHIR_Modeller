// This key cannot collide with an authenticated issuer/subject identity.
export const GLOBAL_IDENTITY = "\0platform/shared-connections";
export const GLOBAL_PERMISSIONS = ["use-global-connections", "manage-global-providers", "manage-global-repositories"];
export function workspaceAccess(store, session) {
    if (!store || !session?.user?.id || session.mfaSetupRequired) return { owner: false, permissions: [] };
    const state = store.read();
    const user = state.users.find(
        (item) => item.id === session.user.id && item.status === "active" && !item.mfaPending,
    );
    if (!user) return { owner: false, permissions: [] };
    const owner = user.id === state.ownerId;
    return { owner, permissions: owner ? [...GLOBAL_PERMISSIONS] : [...(user.permissions || [])] };
}
export function identityCanUseGlobal(store, identity) {
    if (!store || !identity.startsWith(store.issuer + "\n")) return false;
    return workspaceAccess(store, { user: { id: identity.slice(store.issuer.length + 1) } }).permissions.includes(
        "use-global-connections",
    );
}
