import { useDefineApi } from "@/stores/useDefineApi";

export type PlayerActionType =
  | "op"
  | "deop"
  | "kick"
  | "ban"
  | "pardon"
  | "whitelist_add"
  | "whitelist_remove"
  | "kill"
  | "clear_inventory"
  | "gamemode_survival"
  | "gamemode_creative"
  | "gamemode_spectator";

export type PlayerMonitorMode = "fast" | "full";

export interface PlayerRow {
  name: string;
  uuid?: string;
  online: boolean;
  pingMs?: number;
  pingSource?: "mod" | "console" | "unknown";
  isOp: boolean;
  isWhitelisted: boolean;
  lastSeen?: string;
  afk?: boolean;
  sessionPlayMs?: number;
  totalPlayMs?: number;
  totalActiveMs?: number;
  totalAfkMs?: number;
  deaths?: number;
  playerKills?: number;
  mobKills?: number;
  blocksBroken?: number;
  blocksPlaced?: number;
  distanceTotal?: number;
  joinCount?: number;
  firstJoin?: number;
  lastJoin?: number;
  dim?: string;
}

export interface PingHistoryPoint {
  t: number;
  avg?: number;
  min?: number;
  max?: number;
  online: number;
  byPlayer?: Record<string, number>;
}

export type RankRow = { name: string; uuid?: string; value: number };
export type Rankings = Record<string, RankRow[]>;

export interface PlayerMonitorSnapshot {
  instanceUuid: string;
  daemonId: string;
  mode: PlayerMonitorMode;
  onlineCount: number;
  maxPlayers?: number;
  players: PlayerRow[];
  sparkAvailable: boolean;
  sparkSummary?: {
    tps?: number;
    mspt?: number;
    rawHint?: string;
  };
  pingHistory: PingHistoryPoint[];
  rankings?: Rankings;
  collectedAt: number;
  sources: string[];
  warnings: string[];
}

export interface PlayerProfileDetail {
  uuid: string;
  name?: string;
  firstJoin?: number;
  lastJoin?: number;
  lastQuit?: number;
  joinCount?: number;
  totalPlayMs?: number;
  totalActiveMs?: number;
  totalAfkMs?: number;
  deaths?: number;
  playerKills?: number;
  mobKills?: number;
  /** entity type id -> kill count, e.g. minecraft:zombie */
  mobKillsByType?: Record<string, number>;
  damageDealt?: number;
  damageTaken?: number;
  blocksBroken?: number;
  blocksPlaced?: number;
  itemsCrafted?: number;
  itemsPicked?: number;
  chatMessages?: number;
  commandsUsed?: number;
  xpGained?: number;
  distanceWalked?: number;
  distanceFlown?: number;
  distanceElytra?: number;
  distanceBoat?: number;
  distanceHorse?: number;
  distanceMinecart?: number;
  distanceSwim?: number;
  distanceSprint?: number;
  distanceCrouch?: number;
  distanceFall?: number;
  distanceTotal?: number;
  dimensionTimeMs?: Record<string, number>;
  lastDim?: string;
  lastX?: number;
  lastY?: number;
  lastZ?: number;
  lastPingAvg?: number;
  lastPingMax?: number;
}

export const getPlayerMonitorSnapshot = useDefineApi<
  {
    params: {
      uuid: string;
      daemonId: string;
      mode?: PlayerMonitorMode;
    };
  },
  PlayerMonitorSnapshot
>({
  url: "/api/player_monitor/snapshot",
  method: "GET"
});

export const getPlayerProfile = useDefineApi<
  {
    params: {
      uuid: string;
      daemonId: string;
      playerUuid: string;
    };
  },
  PlayerProfileDetail
>({
  url: "/api/player_monitor/profile",
  method: "GET"
});

export const runPlayerMonitorAction = useDefineApi<
  {
    params: {
      uuid: string;
      daemonId: string;
    };
    data: {
      action: PlayerActionType;
      player: string;
      reason?: string;
    };
  },
  {
    ok: boolean;
    command: string;
    message: string;
  }
>({
  url: "/api/player_monitor/action",
  method: "POST"
});
