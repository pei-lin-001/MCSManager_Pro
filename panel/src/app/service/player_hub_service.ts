import crypto from "crypto";
import axios from "axios";
import RemoteServiceSubsystem from "./remote_service";
import RemoteRequest from "./remote_command";
import userSystem from "./user_service";
import { User } from "../entity/user";
import { readPlayerProfile, type PlayerProfileDetail } from "./player_monitor_service";

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export interface BoundPlayerIdentity {
  mcName: string;
  mcUuid: string;
  bindAt: number;
  activityPoints: number;
  checkIn: { lastDate?: string; streak?: number };
}

export interface ServerPlayerCard {
  daemonId: string;
  instanceUuid: string;
  nickname: string;
  status: number;
  online: boolean;
  matchedBy: "uuid" | "name";
  profile: PlayerProfileDetail | null;
}

export interface PlayerHubSummary {
  identity: BoundPlayerIdentity | null;
  servers: ServerPlayerCard[];
  totals: {
    serversFound: number;
    totalPlayMs: number;
    totalDeaths: number;
    totalMobKills: number;
    totalBlocksBroken: number;
    totalBlocksPlaced: number;
    totalDistance: number;
  };
  /** Reserved for upcoming check-in / activities */
  activity: {
    points: number;
    checkIn: { lastDate?: string; streak?: number };
    features: Array<{ id: string; title: string; enabled: boolean; hint?: string }>;
  };
}

function normalizeUuid(id: string): string {
  const raw = String(id || "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  if (raw.length !== 32) return "";
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function offlineUuidFromName(name: string): string {
  // Mojang offline UUID: MD5("OfflinePlayer:<name>") with version/variant bits
  const hash = crypto.createHash("md5").update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return normalizeUuid(hex);
}

export async function resolveMinecraftIdentity(name: string): Promise<{ mcName: string; mcUuid: string; mode: "online" | "offline" }> {
  const mcName = String(name || "").trim();
  if (!NAME_RE.test(mcName)) {
    throw new Error("Invalid Minecraft name (3-16 letters/numbers/underscore)");
  }
  try {
    const res = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(mcName)}`, {
      timeout: 5000,
      validateStatus: (s) => s === 200 || s === 204 || s === 404
    });
    if (res.status === 200 && res.data?.id) {
      const uuid = normalizeUuid(String(res.data.id));
      const officialName = String(res.data.name || mcName);
      if (uuid) return { mcName: officialName, mcUuid: uuid, mode: "online" };
    }
  } catch {
    // fall through offline
  }
  return { mcName, mcUuid: offlineUuidFromName(mcName), mode: "offline" };
}

export function getBoundIdentity(user: User): BoundPlayerIdentity | null {
  if (!user?.mcName || !user?.mcUuid) return null;
  return {
    mcName: user.mcName,
    mcUuid: user.mcUuid,
    bindAt: user.bindAt || 0,
    activityPoints: user.activityPoints || 0,
    checkIn: user.checkIn || {}
  };
}

export async function bindMinecraftToUser(userUuid: string, name: string): Promise<BoundPlayerIdentity> {
  const user = userSystem.getInstance(userUuid);
  if (!user) throw new Error("User not found");
  const resolved = await resolveMinecraftIdentity(name);

  // unique bind: one mcUuid -> one panel user
  for (const [, other] of userSystem.objects) {
    if (other.uuid === userUuid) continue;
    if (other.mcUuid && normalizeUuid(other.mcUuid) === normalizeUuid(resolved.mcUuid)) {
      throw new Error("This Minecraft account is already bound to another user");
    }
    if (other.mcName && other.mcName.toLowerCase() === resolved.mcName.toLowerCase()) {
      throw new Error("This Minecraft name is already bound to another user");
    }
  }

  await userSystem.edit(userUuid, {
    mcName: resolved.mcName,
    mcUuid: resolved.mcUuid,
    bindAt: Date.now()
  });
  const fresh = userSystem.getInstance(userUuid)!;
  return getBoundIdentity(fresh)!;
}

export async function unbindMinecraftFromUser(userUuid: string): Promise<boolean> {
  await userSystem.edit(userUuid, { mcName: "", mcUuid: "", bindAt: 0 });
  return true;
}

async function listDaemonInstances(daemonId: string): Promise<Array<{ instanceUuid: string; nickname: string; status: number }>> {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService?.available) return [];
  const remote = new RemoteRequest(remoteService);
  try {
    const result = await remote.request("instance/select", {
      page: 1,
      pageSize: 200,
      condition: {}
    });
    const data = result?.data || [];
    const arr = Array.isArray(data) ? data : [];
    return arr
      .map((it: any) => ({
        instanceUuid: String(it.instanceUuid || it.uuid || ""),
        nickname: String(it.config?.nickname || it.nickname || it.instanceUuid || ""),
        status: Number(it.status ?? 0)
      }))
      .filter((it) => it.instanceUuid);
  } catch {
    return [];
  }
}

async function listProfileFiles(daemonId: string, instanceUuid: string): Promise<string[]> {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService?.available) return [];
  const remote = new RemoteRequest(remoteService);
  const names: string[] = [];
  for (let page = 0; page < 50; page++) {
    try {
      const overview = await remote.request("file/list", {
        instanceUuid,
        target: "mcsm-metrics/players",
        page,
        pageSize: 100,
        fileName: ""
      });
      const items = overview?.items || overview?.files || [];
      const arr = Array.isArray(items) ? items : [];
      if (!arr.length) break;
      for (const f of arr) {
        const n = String(f?.name || f?.fileName || f || "");
        if (n.toLowerCase().endsWith(".json")) names.push(n);
      }
      const total = Number(overview?.total ?? 0);
      if (total && names.length >= total) break;
      if (arr.length < 100) break;
    } catch {
      break;
    }
  }
  return names;
}

async function findProfileOnInstance(
  daemonId: string,
  instanceUuid: string,
  mcUuid: string,
  mcName: string
): Promise<{ profile: PlayerProfileDetail; matchedBy: "uuid" | "name" } | null> {
  // fast path: uuid file
  const byUuid = await readPlayerProfile(daemonId, instanceUuid, mcUuid);
  if (byUuid) return { profile: byUuid, matchedBy: "uuid" };

  // slow path: list profiles and match name (offline/online rename tolerance)
  const files = await listProfileFiles(daemonId, instanceUuid);
  for (const file of files.slice(0, 300)) {
    const id = file.replace(/\.json$/i, "");
    if (!/^[0-9a-fA-F-]{32,36}$/.test(id)) continue;
    const profile = await readPlayerProfile(daemonId, instanceUuid, id);
    if (!profile) continue;
    if (profile.name && profile.name.toLowerCase() === mcName.toLowerCase()) {
      return { profile, matchedBy: "name" };
    }
  }
  return null;
}

export async function collectPlayerHubForUser(userUuid: string): Promise<PlayerHubSummary> {
  const user = userSystem.getInstance(userUuid);
  if (!user) throw new Error("User not found");
  const identity = getBoundIdentity(user);

  const activity = {
    points: user.activityPoints || 0,
    checkIn: user.checkIn || {},
    features: [
      {
        id: "checkin",
        title: "Daily check-in",
        enabled: false,
        hint: "Coming soon"
      },
      {
        id: "events",
        title: "Events",
        enabled: false,
        hint: "Coming soon"
      }
    ]
  };

  if (!identity) {
    return {
      identity: null,
      servers: [],
      totals: {
        serversFound: 0,
        totalPlayMs: 0,
        totalDeaths: 0,
        totalMobKills: 0,
        totalBlocksBroken: 0,
        totalBlocksPlaced: 0,
        totalDistance: 0
      },
      activity
    };
  }

  const servers: ServerPlayerCard[] = [];
  for (const [daemonId, service] of RemoteServiceSubsystem.services.entries()) {
    if (!service.available) continue;
    const instances = await listDaemonInstances(daemonId);
    for (const inst of instances) {
      const found = await findProfileOnInstance(daemonId, inst.instanceUuid, identity.mcUuid, identity.mcName);
      if (!found) continue;
      const p = found.profile;
      servers.push({
        daemonId,
        instanceUuid: inst.instanceUuid,
        nickname: inst.nickname,
        status: inst.status,
        online: Boolean((p as any).online),
        matchedBy: found.matchedBy,
        profile: p
      });
    }
  }

  // sort by last activity
  servers.sort((a, b) => Number(b.profile?.lastJoin || 0) - Number(a.profile?.lastJoin || 0));

  const totals = servers.reduce(
    (acc, s) => {
      const p = s.profile || ({} as PlayerProfileDetail);
      acc.serversFound += 1;
      acc.totalPlayMs += Number(p.totalPlayMs || 0);
      acc.totalDeaths += Number(p.deaths || 0);
      acc.totalMobKills += Number(p.mobKills || 0);
      acc.totalBlocksBroken += Number(p.blocksBroken || 0);
      acc.totalBlocksPlaced += Number(p.blocksPlaced || 0);
      acc.totalDistance += Number(p.distanceTotal || 0);
      return acc;
    },
    {
      serversFound: 0,
      totalPlayMs: 0,
      totalDeaths: 0,
      totalMobKills: 0,
      totalBlocksBroken: 0,
      totalBlocksPlaced: 0,
      totalDistance: 0
    }
  );

  return { identity, servers, totals, activity };
}
