import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/author-permissions.ts
function getPermissionLevel(association) {
  if (!association) return PERMISSION_HIERARCHY.length;
  const index = PERMISSION_HIERARCHY.indexOf(association.toUpperCase());
  return index === -1 ? PERMISSION_HIERARCHY.length : index;
}
function hasMinPermission(authorAssociation, minPermission, isLocalMode = false) {
  if (isLocalMode) {
    return true;
  }
  const authorLevel = getPermissionLevel(authorAssociation);
  const minLevel = getPermissionLevel(minPermission);
  return authorLevel <= minLevel;
}
function isOwner(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return authorAssociation?.toUpperCase() === "OWNER";
}
function isMember(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, "MEMBER", isLocalMode);
}
function isCollaborator(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, "COLLABORATOR", isLocalMode);
}
function isContributor(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return true;
  return hasMinPermission(authorAssociation, "CONTRIBUTOR", isLocalMode);
}
function isFirstTimer(authorAssociation, isLocalMode = false) {
  if (isLocalMode) return false;
  const assoc = authorAssociation?.toUpperCase();
  return assoc === "FIRST_TIME_CONTRIBUTOR" || assoc === "FIRST_TIMER";
}
function createPermissionHelpers(authorAssociation, isLocalMode = false) {
  return {
    hasMinPermission: (minPermission) => hasMinPermission(authorAssociation, minPermission, isLocalMode),
    isOwner: () => isOwner(authorAssociation, isLocalMode),
    isMember: () => isMember(authorAssociation, isLocalMode),
    isCollaborator: () => isCollaborator(authorAssociation, isLocalMode),
    isContributor: () => isContributor(authorAssociation, isLocalMode),
    isFirstTimer: () => isFirstTimer(authorAssociation, isLocalMode)
  };
}
function detectLocalMode() {
  return !process.env.GITHUB_ACTIONS;
}
function resolveAssociationFromEvent(eventContext, fallback) {
  try {
    const ec = eventContext || {};
    return ec?.comment?.author_association || ec?.issue?.author_association || ec?.pull_request?.author_association || fallback;
  } catch {
    return fallback;
  }
}
var PERMISSION_HIERARCHY;
var init_author_permissions = __esm({
  "src/utils/author-permissions.ts"() {
    "use strict";
    PERMISSION_HIERARCHY = [
      "OWNER",
      "MEMBER",
      "COLLABORATOR",
      "CONTRIBUTOR",
      "FIRST_TIME_CONTRIBUTOR",
      "FIRST_TIMER",
      "NONE"
    ];
  }
});

export {
  hasMinPermission,
  isOwner,
  isMember,
  isCollaborator,
  isContributor,
  isFirstTimer,
  createPermissionHelpers,
  detectLocalMode,
  resolveAssociationFromEvent,
  init_author_permissions
};
//# sourceMappingURL=chunk-25IC7KXZ.mjs.map