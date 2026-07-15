import fs from "fs-extra";
import path from "path";
import Instance from "../../instance/instance";
import { ILifeCycleTask } from "../../instance/life_cycle";

export type McsmPlayerLive = {
  name: string;
  uuid?: string;
  pingMs?: number;
  dim?: string;
  x?: number;
  y?: number;
  z?: number;
  afk?: boolean;
  sessionPlayMs?: number;
  sessionActiveMs?: number;
  sessionAfkMs?: number;
  totalPlayMs?: number;
  totalActiveMs?: number;
  totalAfkMs?: number;
  deaths?: number;
  playerKills?: number;
  mobKills?: number;
  mobKillsByType?: Record<string, number>;
  blocksBroken?: number;
  blocksPlaced?: number;
  distanceTotal?: number;
  joinCount?: number;
  firstJoin?: number;
  lastJoin?: number;
};

export type McsmRankRow = { name: string; uuid?: string; value: number };
export type McsmRankings = Record<string, McsmRankRow[]>;

type MetricsFile = {
  schema?: number;
  ts?: number;
  modVersion?: string;
  performance?: {
    tps?: { s5?: number; s10?: number; m1?: number };
    mspt?: { med10s?: number; p95_10s?: number; max10s?: number };
    tickLoadPct?: number;
  };
  playersOnline?: any[];
  playersOnlineCount?: number;
  maxPlayers?: number;
  rankings?: McsmRankings;
};

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read mcsm-metrics.json written by the companion Forge mod (v0.2+).
 * Low-cost source for TPS/MSPT/player ping + extended player stats/rankings.
 */
export default class McsmMetricsFileTask implements ILifeCycleTask {
  public status: number = 0;
  public name: string = "McsmMetricsFile";

  private timer: NodeJS.Timeout | null = null;
  private historyLimit = 240;

  private metricsPath(instance: Instance): string {
    return path.join(instance.absoluteCwdPath(), "mcsm-metrics.json");
  }

  private readMetrics(instance: Instance): MetricsFile | null {
    try {
      const p = this.metricsPath(instance);
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, "utf8");
      if (!raw.trim()) return null;
      return JSON.parse(raw) as MetricsFile;
    } catch {
      return null;
    }
  }

  private mapPlayer(raw: any): McsmPlayerLive | null {
    if (!raw || typeof raw.name !== "string") return null;
    return {
      name: String(raw.name),
      uuid: raw.uuid ? String(raw.uuid) : undefined,
      pingMs: num(raw.pingMs) != null ? Math.round(num(raw.pingMs)!) : undefined,
      dim: raw.dim ? String(raw.dim) : undefined,
      x: num(raw.x),
      y: num(raw.y),
      z: num(raw.z),
      afk: !!raw.afk,
      sessionPlayMs: num(raw.sessionPlayMs),
      sessionActiveMs: num(raw.sessionActiveMs),
      sessionAfkMs: num(raw.sessionAfkMs),
      totalPlayMs: num(raw.totalPlayMs),
      totalActiveMs: num(raw.totalActiveMs),
      totalAfkMs: num(raw.totalAfkMs),
      deaths: num(raw.deaths),
      playerKills: num(raw.playerKills),
      mobKills: num(raw.mobKills),
      blocksBroken: num(raw.blocksBroken),
      blocksPlaced: num(raw.blocksPlaced),
      distanceTotal: num(raw.distanceTotal),
      joinCount: num(raw.joinCount),
      firstJoin: num(raw.firstJoin),
      lastJoin: num(raw.lastJoin)
    };
  }

  private apply(instance: Instance) {
    const data = this.readMetrics(instance);
    if (!data) {
      if (instance.info.mcsmMetricsAgeMs != null) {
        instance.info = {
          ...instance.info,
          mcsmMetricsAgeMs: Date.now() - (instance.info.mcsmMetricsTs || 0)
        };
      }
      return;
    }

    const ts = Number(data.ts) || Date.now();
    const age = Math.max(0, Date.now() - ts);
    if (age > 30_000) {
      instance.info = {
        ...instance.info,
        mcsmMetricsTs: ts,
        mcsmMetricsAgeMs: age,
        mcsmMetricsOk: false
      };
      return;
    }

    const tps = data.performance?.tps?.s5;
    const mspt = data.performance?.mspt?.med10s;
    const load =
      data.performance?.tickLoadPct != null
        ? Number(data.performance.tickLoadPct)
        : mspt != null
          ? Math.min(999, (Number(mspt) / 50) * 100)
          : undefined;

    const players = (Array.isArray(data.playersOnline) ? data.playersOnline : [])
      .map((p) => this.mapPlayer(p))
      .filter((p): p is McsmPlayerLive => !!p);

    const history = [...(instance.info.tpsHistory || [])];
    if (tps != null || mspt != null) {
      history.push({
        value: tps != null ? String(Number(tps).toFixed(2)) : "20",
        mspt: mspt != null ? String(Number(mspt).toFixed(2)) : undefined,
        time: ts
      });
      while (history.length > this.historyLimit) history.shift();
    }

    // normalize rankings values
    const rankings: McsmRankings = {};
    if (data.rankings && typeof data.rankings === "object") {
      for (const [k, rows] of Object.entries(data.rankings)) {
        if (!Array.isArray(rows)) continue;
        rankings[k] = rows
          .filter((r) => r && r.name)
          .slice(0, 10)
          .map((r: any) => ({
            name: String(r.name),
            uuid: r.uuid ? String(r.uuid) : undefined,
            value: Number(r.value) || 0
          }));
      }
    }

    instance.info = {
      ...instance.info,
      tps: tps != null ? Number(Number(tps).toFixed(2)) : instance.info.tps,
      mspt: mspt != null ? Number(Number(mspt).toFixed(2)) : instance.info.mspt,
      tpsAvg: tps != null ? Number(Number(tps).toFixed(2)) : instance.info.tpsAvg,
      tpsUpdatedAt: ts,
      tpsSource: "mcsm_metrics",
      tpsLoadPercent: load != null ? Number(Number(load).toFixed(1)) : instance.info.tpsLoadPercent,
      tpsHistory: history.length ? history : instance.info.tpsHistory,
      currentPlayers:
        data.playersOnlineCount != null ? Number(data.playersOnlineCount) : players.length,
      maxPlayers: data.maxPlayers != null ? Number(data.maxPlayers) : instance.info.maxPlayers,
      mcPingOnline: true,
      mcsmMetricsOk: true,
      mcsmMetricsTs: ts,
      mcsmMetricsAgeMs: age,
      mcsmModVersion: data.modVersion ? String(data.modVersion) : undefined,
      mcsmPlayers: players,
      mcsmRankings: rankings
    };
  }

  async start(instance: Instance) {
    const type = String(instance.config.type || "").toLowerCase();
    if (!(type.includes("minecraft/java") || type.includes("universal/mcdr"))) return;
    this.status = 1;
    this.apply(instance);
    this.timer = setInterval(() => this.apply(instance), 2000);
  }

  async stop(instance: Instance) {
    this.status = 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    instance.info = {
      ...instance.info,
      mcsmMetricsOk: false,
      mcsmMetricsAgeMs: undefined,
      mcsmPlayers: undefined,
      mcsmRankings: undefined
    };
  }
}
