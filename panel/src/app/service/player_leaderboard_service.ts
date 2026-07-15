import RemoteServiceSubsystem from "./remote_service";
import RemoteRequest from "./remote_command";
import { readPlayerProfile, type PlayerProfileDetail } from "./player_monitor_service";

export type LeaderboardMetric =
  | "playtime"
  | "activePlaytime"
  | "mobKills"
  | "playerKills"
  | "blocksBroken"
  | "blocksPlaced"
  | "deaths"
  | "distance"
  | "xpGained";

export const LEADERBOARD_METRICS: LeaderboardMetric[] = [
  "playtime",
  "activePlaytime",
  "mobKills",
  "playerKills",
  "blocksBroken",
  "blocksPlaced",
  "deaths",
  "distance",
  "xpGained"
];

export interface LeaderboardServerOption {
  daemonId: string;
  instanceUuid: string;
  nickname: string;
  status: number;
  playerCount: number;
}

export interface LeaderboardRow {
  rank: number;
  name: string;
  uuid: string;
  value: number;
  totalPlayMs: number;
  totalActiveMs: number;
  mobKills: number;
  playerKills: number;
  blocksBroken: number;
  blocksPlaced: number;
  deaths: number;
  distanceTotal: number;
  xpGained: number;
  servers: string[];
  lastJoin?: number;
}

export interface LeaderboardSummary {
  metric: LeaderboardMetric;
  limit: number;
  scope: "all" | "server";
  server?: { daemonId: string; instanceUuid: string; nickname: string } | null;
  servers: LeaderboardServerOption[];
  totalPlayers: number;
  rows: LeaderboardRow[];
  collectedAt: number;
  warnings: string[];
}

function normalizeUuid(id: string): string {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "");
}

function prettyUuid(id: string): string {
  const n = normalizeUuid(id);
  if (n.length !== 32) return id;
  return `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20)}`;
}

function metricValue(profile: PlayerProfileDetail, metric: LeaderboardMetric): number {
  switch (metric) {
    case "playtime":
      return Number(profile.totalPlayMs || 0);
    case "activePlaytime":
      return Number(profile.totalActiveMs || profile.totalPlayMs || 0);
    case "mobKills":
      return Number(profile.mobKills || 0);
    case "playerKills":
      return Number(profile.playerKills || 0);
    case "blocksBroken":
      return Number(profile.blocksBroken || 0);
    case "blocksPlaced":
      return Number(profile.blocksPlaced || 0);
    case "deaths":
      return Number(profile.deaths || 0);
    case "distance":
      return Number(profile.distanceTotal || 0);
    case "xpGained":
      return Number(profile.xpGained || 0);
    default:
      return 0;
  }
}

async function listDaemonInstances(
  daemonId: string
): Promise<Array<{ instanceUuid: string; nickname: string; status: number }>> {
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
  // daemon file/list: page is 0-based, pageSize max 100
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

interface AggPlayer {
  name: string;
  uuid: string;
  totalPlayMs: number;
  totalActiveMs: number;
  mobKills: number;
  playerKills: number;
  blocksBroken: number;
  blocksPlaced: number;
  deaths: number;
  distanceTotal: number;
  xpGained: number;
  servers: Set<string>;
  lastJoin: number;
}

function emptyAgg(uuid: string, name: string): AggPlayer {
  return {
    name,
    uuid,
    totalPlayMs: 0,
    totalActiveMs: 0,
    mobKills: 0,
    playerKills: 0,
    blocksBroken: 0,
    blocksPlaced: 0,
    deaths: 0,
    distanceTotal: 0,
    xpGained: 0,
    servers: new Set(),
    lastJoin: 0
  };
}

function mergeProfile(agg: AggPlayer, profile: PlayerProfileDetail, serverLabel: string) {
  if (profile.name) agg.name = profile.name;
  if (profile.uuid) agg.uuid = prettyUuid(profile.uuid);
  agg.totalPlayMs += Number(profile.totalPlayMs || 0);
  agg.totalActiveMs += Number(profile.totalActiveMs || 0);
  agg.mobKills += Number(profile.mobKills || 0);
  agg.playerKills += Number(profile.playerKills || 0);
  agg.blocksBroken += Number(profile.blocksBroken || 0);
  agg.blocksPlaced += Number(profile.blocksPlaced || 0);
  agg.deaths += Number(profile.deaths || 0);
  agg.distanceTotal += Number(profile.distanceTotal || 0);
  agg.xpGained += Number(profile.xpGained || 0);
  agg.servers.add(serverLabel);
  agg.lastJoin = Math.max(agg.lastJoin, Number(profile.lastJoin || 0));
}

function rowValue(agg: AggPlayer, metric: LeaderboardMetric): number {
  switch (metric) {
    case "playtime":
      return agg.totalPlayMs;
    case "activePlaytime":
      return agg.totalActiveMs || agg.totalPlayMs;
    case "mobKills":
      return agg.mobKills;
    case "playerKills":
      return agg.playerKills;
    case "blocksBroken":
      return agg.blocksBroken;
    case "blocksPlaced":
      return agg.blocksPlaced;
    case "deaths":
      return agg.deaths;
    case "distance":
      return agg.distanceTotal;
    case "xpGained":
      return agg.xpGained;
    default:
      return 0;
  }
}

export async function collectGlobalLeaderboard(opts: {
  metric?: string;
  limit?: number;
  daemonId?: string;
  instanceUuid?: string;
}): Promise<LeaderboardSummary> {
  const metricRaw = String(opts.metric || "playtime");
  const metric = (LEADERBOARD_METRICS.includes(metricRaw as LeaderboardMetric)
    ? metricRaw
    : "playtime") as LeaderboardMetric;
  const limit = Math.max(1, Math.min(100, Number(opts.limit || 50) || 50));
  const filterDaemon = String(opts.daemonId || "").trim();
  const filterInstance = String(opts.instanceUuid || "").trim();
  const scope: "all" | "server" = filterDaemon && filterInstance ? "server" : "all";

  const warnings: string[] = [];
  const servers: LeaderboardServerOption[] = [];
  const byKey = new Map<string, AggPlayer>();

  for (const [daemonId, service] of RemoteServiceSubsystem.services.entries()) {
    if (!service.available) continue;
    if (filterDaemon && daemonId !== filterDaemon) continue;

    const instances = await listDaemonInstances(daemonId);
    for (const inst of instances) {
      if (filterInstance && inst.instanceUuid !== filterInstance) continue;

      const files = await listProfileFiles(daemonId, inst.instanceUuid);
      let playerCount = 0;
      const serverLabel = inst.nickname || inst.instanceUuid;

      // Cap per-instance reads to keep the API responsive.
      for (const file of files.slice(0, 400)) {
        const id = file.replace(/\.json$/i, "");
        if (!/^[0-9a-fA-F-]{32,36}$/.test(id)) continue;
        const profile = await readPlayerProfile(daemonId, inst.instanceUuid, id);
        if (!profile) continue;
        playerCount += 1;

        const key =
          normalizeUuid(profile.uuid || id) ||
          String(profile.name || id).toLowerCase();
        if (!key) continue;

        let agg = byKey.get(key);
        if (!agg) {
          agg = emptyAgg(prettyUuid(profile.uuid || id), String(profile.name || "Unknown"));
          byKey.set(key, agg);
        }
        // When filtering one server, still merge once; when all, sum across servers.
        if (scope === "server") {
          // overwrite with single-server stats
          agg = emptyAgg(prettyUuid(profile.uuid || id), String(profile.name || "Unknown"));
          byKey.set(key, agg);
        }
        mergeProfile(agg, profile, serverLabel);
        // metricValue kept for potential future per-server rank use
        void metricValue(profile, metric);
      }

      if (files.length || playerCount) {
        servers.push({
          daemonId,
          instanceUuid: inst.instanceUuid,
          nickname: serverLabel,
          status: inst.status,
          playerCount
        });
      }
    }
  }

  servers.sort((a, b) => b.playerCount - a.playerCount || a.nickname.localeCompare(b.nickname));

  const rowsAll = Array.from(byKey.values())
    .map((agg) => {
      const value = rowValue(agg, metric);
      return {
        rank: 0,
        name: agg.name,
        uuid: agg.uuid,
        value,
        totalPlayMs: agg.totalPlayMs,
        totalActiveMs: agg.totalActiveMs,
        mobKills: agg.mobKills,
        playerKills: agg.playerKills,
        blocksBroken: agg.blocksBroken,
        blocksPlaced: agg.blocksPlaced,
        deaths: agg.deaths,
        distanceTotal: agg.distanceTotal,
        xpGained: agg.xpGained,
        servers: Array.from(agg.servers),
        lastJoin: agg.lastJoin || undefined
      } as LeaderboardRow;
    })
    .filter((r) => r.value > 0 || r.totalPlayMs > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  rowsAll.forEach((r, i) => {
    r.rank = i + 1;
  });

  if (!rowsAll.length) {
    warnings.push("No player profiles found. Install mcsm_metrics and play on a server first.");
  }

  const selectedServer =
    scope === "server"
      ? servers.find((s) => s.daemonId === filterDaemon && s.instanceUuid === filterInstance) || {
          daemonId: filterDaemon,
          instanceUuid: filterInstance,
          nickname: filterInstance
        }
      : null;

  return {
    metric,
    limit,
    scope,
    server: selectedServer
      ? {
          daemonId: selectedServer.daemonId,
          instanceUuid: selectedServer.instanceUuid,
          nickname: selectedServer.nickname
        }
      : null,
    servers,
    totalPlayers: rowsAll.length,
    rows: rowsAll.slice(0, limit),
    collectedAt: Date.now(),
    warnings
  };
}
