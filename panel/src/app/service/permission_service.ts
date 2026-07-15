import userSystem from "./user_service";
import { ROLE, User } from "../entity/user";

export function isHaveInstance(user: User, daemonId: string, instanceUuid: string) {
  // Super admin + manager can operate any instance
  if (isManagerPermission(user)) return true;
  if (user && user.instances) {
    for (const v of user.instances) {
      if (daemonId === v.daemonId && instanceUuid === v.instanceUuid) return true;
    }
  }
  return false;
}

export function isTopPermission(user: User) {
  if (!user) return false;
  return user.permission >= ROLE.ADMIN;
}

/** Manager or super admin (staff). */
export function isManagerPermission(user: User) {
  if (!user) return false;
  return user.permission >= ROLE.MANAGER;
}

export function isManagerPermissionByUuid(uuid: string) {
  const user = userSystem.getInstance(uuid);
  if (!user) return false;
  return isManagerPermission(user);
}

export function resolveRole(permission: number) {
  if (permission >= ROLE.ADMIN) return ROLE.ADMIN;
  if (permission >= ROLE.MANAGER) return ROLE.MANAGER;
  if (permission >= ROLE.USER) return ROLE.USER;
  if (permission === ROLE.BAN) return ROLE.BAN;
  return ROLE.GUEST;
}

export function isTopPermissionByUuid(uuid: string) {
  const user = userSystem.getInstance(uuid);
  if (!user) return false;
  return isTopPermission(user);
}

export function isHaveInstanceByUuid(uuid: string, daemonId: string, instanceUuid: string) {
  const user = userSystem.getInstance(uuid);
  if (!user) return false;
  return isHaveInstance(user, daemonId, instanceUuid);
}

export function getUserByUserName(userName: string) {
  return userSystem.getUserByUserName(userName);
}
