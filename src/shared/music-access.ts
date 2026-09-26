import type { UserRole } from "./types.js";

export interface MusicAccessUser {
  id: string;
  role: UserRole;
}

export function isAdminMusicRole(role: UserRole): boolean {
  return role === "admin" || role === "admin-advanced" || role === "super-admin";
}

export function canPlayWinMusic(actor: MusicAccessUser, target: MusicAccessUser): boolean {
  return !isAdminMusicRole(target.role) || actor.id === target.id || actor.role === "super-admin";
}

export function canDownloadWinMusic(actor: MusicAccessUser, target: MusicAccessUser): boolean {
  if (actor.id === target.id || actor.role === "super-admin") return true;
  return isAdminMusicRole(actor.role) && !isAdminMusicRole(target.role);
}

/** Administrators may directly play every victory sound they are allowed to download. */
export function canPlayDownloadedWinMusic(actor: MusicAccessUser, target: MusicAccessUser): boolean {
  return isAdminMusicRole(actor.role) && canDownloadWinMusic(actor, target);
}

export function canManageWinMusic(actor: MusicAccessUser, target: MusicAccessUser): boolean {
  return actor.id === target.id || actor.role === "super-admin";
}
