import { useDefineApi } from "@/stores/useDefineApi";

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

export const getGlobalLeaderboard = useDefineApi<
  {
    params?: {
      metric?: LeaderboardMetric | string;
      limit?: number;
      daemonId?: string;
      instanceUuid?: string;
    };
  },
  LeaderboardSummary
>({
  url: "/api/player_hub/leaderboard",
  method: "GET"
});
