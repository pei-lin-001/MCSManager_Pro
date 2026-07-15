import { useDefineApi } from "@/stores/useDefineApi";
import type { PlayerProfileDetail } from "./playerMonitor";

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
  activity: {
    points: number;
    checkIn: { lastDate?: string; streak?: number };
    features: Array<{ id: string; title: string; enabled: boolean; hint?: string }>;
  };
}

export const getPlayerHubMe = useDefineApi<any, { identity: BoundPlayerIdentity | null }>({
  url: "/api/player_hub/me",
  method: "GET"
});

export const bindMinecraftName = useDefineApi<
  { data: { mcName: string } },
  BoundPlayerIdentity
>({
  url: "/api/player_hub/bind",
  method: "POST"
});

export const unbindMinecraftName = useDefineApi<any, boolean>({
  url: "/api/player_hub/bind",
  method: "DELETE"
});

export const getPlayerHubProfiles = useDefineApi<any, PlayerHubSummary>({
  url: "/api/player_hub/profiles",
  method: "GET"
});
