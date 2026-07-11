import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

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

export type RankRow = { name: string; uuid?: string; value: number };
export type Rankings = Record<string, RankRow[]>;

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

export type PlayerMonitorMode = "fast" | "full";

export interface PingHistoryPoint {
  t: number;
  avg?: number;
  min?: number;
  max?: number;
  online: number;
  /** sparse per-player samples for the chart legend (online only). */
  byPlayer?: Record<string, number>;
}

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
    rawHint?: string; // mcsm_metrics | forge/console
  };
  /** Rolling latency samples retained server-side (for reload / multi-tab). */
  pingHistory: PingHistoryPoint[];
  rankings?: Rankings;
  collectedAt: number;
  sources: string[];
  warnings: string[];
}

const HISTORY_LIMIT = 240; // ~1h if sampled every 15s
const historyByInstance = new Map<string, PingHistoryPoint[]>();

function historyKey(daemonId: string, instanceUuid: string): string {
  return `${daemonId}:${instanceUuid}`;
}

function pushPingHistory(
  daemonId: string,
  instanceUuid: string,
  players: PlayerRow[],
  onlineCount: number
): PingHistoryPoint[] {
  const key = historyKey(daemonId, instanceUuid);
  const list = historyByInstance.get(key) || [];
  const pings = players
    .filter((p) => p.online && p.pingMs != null && Number.isFinite(p.pingMs))
    .map((p) => ({ name: p.name, ping: Number(p.pingMs) }));

  const point: PingHistoryPoint = {
    t: Date.now(),
    online: onlineCount
  };

  if (pings.length > 0) {
    const values = pings.map((p) => p.ping);
    point.avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    point.min = Math.min(...values);
    point.max = Math.max(...values);
    const byPlayer: Record<string, number> = {};
    // Keep at most 12 series to avoid huge payloads.
    for (const row of pings.slice(0, 12)) byPlayer[row.name] = row.ping;
    point.byPlayer = byPlayer;
  }

  list.push(point);
  while (list.length > HISTORY_LIMIT) list.shift();
  historyByInstance.set(key, list);
  return list.slice();
}

export function getPingHistory(daemonId: string, instanceUuid: string): PingHistoryPoint[] {
  return (historyByInstance.get(historyKey(daemonId, instanceUuid)) || []).slice();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  // TS target here is older than Promise.withResolvers typings.
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stripControl(text: string): string {
  return String(text || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/§[0-9a-fk-or]/gi, "");
}

function isValidPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name);
}

function parseListOutput(logText: string): {
  names: string[];
  maxPlayers?: number;
  onlineCount?: number;
} {
  const text = stripControl(logText);
  const lines = text.split(/\r?\n/).reverse();
  const re =
    /There are\s+(\d+)\s+of\s+a\s+max\s+of\s+(\d+)\s+players?\s+online:\s*(.*)$/i;

  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const onlineCount = Number(m[1]);
    const maxPlayers = Number(m[2]);
    const rest = (m[3] || "").trim();
    const names = rest
      ? rest
          .split(",")
          .map((s) => s.trim())
          .filter((s) => isValidPlayerName(s))
      : [];
    return {
      names,
      maxPlayers: Number.isFinite(maxPlayers) ? maxPlayers : undefined,
      onlineCount: Number.isFinite(onlineCount) ? onlineCount : names.length
    };
  }
  return { names: [] };
}

function parseSparkPlayerPings(logText: string): Map<string, number> {
  const text = stripControl(logText);
  const map = new Map<string, number>();
  // Spark formats (Adventure text flattened to console):
  //   Player ShelterPL0209 has 42 ms ping.
  //   Ping data is not available for 'foo'.
  // Also tolerate compact variants.
  const patterns = [
    /Player\s+([A-Za-z0-9_]{1,16})\s+has\s+([\d.]+)\s*ms\s*ping/i,
    /(?:Player\s+)?([A-Za-z0-9_]{1,16})\s*[:=\-–]\s*([\d.]+)\s*ms(?:\s*ping)?/i,
    /([A-Za-z0-9_]{1,16})\s+([\d.]+)\s*ms\s*ping/i
  ];

  for (const line of text.split(/\r?\n/)) {
    for (const re of patterns) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1];
      const ping = Number(m[2]);
      if (!isValidPlayerName(name) || !Number.isFinite(ping)) continue;
      map.set(name, Math.max(0, Math.round(ping)));
      break;
    }
  }
  return map;
}

function parseSparkSummary(logText: string): { tps?: number; mspt?: number; rawHint?: string } {
  const text = stripControl(logText);
  const out: { tps?: number; mspt?: number; rawHint?: string } = {};

  // Spark multi-line:
  // TPS from last 5s, 10s, 1m, 5m, 15m:
  //     20.0, 20.0, *20.0, *20.0, *20.0
  const tpsBlock = text.match(/TPS from last[^\n]*:\s*\n?\s*([*\d.,\s]+)/i);
  if (tpsBlock) {
    const nums: number[] = [];
    const numRe = /[*]?([\d.]+)/g;
    let nm: RegExpExecArray | null;
    while ((nm = numRe.exec(tpsBlock[1])) != null) {
      const v = Number(nm[1]);
      if (Number.isFinite(v)) nums.push(v);
    }
    const v = nums.find((n) => Number.isFinite(n));
    if (v != null) out.tps = v;
  } else {
    const tpsLine = text.match(
      /TPS from last[^:]*:\s*[*\s]*([\d.]+)(?:\s*,\s*[*\s]*([\d.]+))?/i
    );
    if (tpsLine) {
      const v = Number(tpsLine[1]);
      if (Number.isFinite(v)) out.tps = v;
    }
  }

  // Tick durations (min/med/95%ile/max ms) ...
  //     0.5/0.9/1.3/5.2; ...
  const tick = text.match(
    /Tick durations[^\n]*:\s*\n?\s*([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)/i
  );
  if (tick) {
    const med = Number(tick[2]);
    if (Number.isFinite(med)) out.mspt = med;
  } else {
    const msptLine =
      text.match(/MSPT from last[^:]*:\s*[*\s]*([\d.]+)/i) ||
      text.match(/Mean tick time:\s*([\d.]+)\s*ms/i);
    if (msptLine) {
      const v = Number(msptLine[1]);
      if (Number.isFinite(v)) out.mspt = v;
    }
  }

  if (out.tps != null || out.mspt != null) out.rawHint = "spark health";
  return out;
}

function parseNameUuidList(raw: unknown): Array<{ name: string; uuid?: string }> {
  if (!Array.isArray(raw)) return [];
  const rows: Array<{ name: string; uuid?: string }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name : "";
    if (!isValidPlayerName(name)) continue;
    const uuid = typeof item.uuid === "string" ? item.uuid : undefined;
    rows.push({ name, uuid });
  }
  return rows;
}

async function readInstanceJsonFile(
  remote: RemoteRequest,
  instanceUuid: string,
  target: string
): Promise<unknown> {
  try {
    const raw = await remote.request("file/edit", {
      instanceUuid,
      target,
      text: null
    });
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

async function sendCommand(
  remote: RemoteRequest,
  instanceUuid: string,
  command: string
): Promise<void> {
  await remote.request("instance/command", {
    instanceUuid,
    command
  });
}

async function readOutputLog(remote: RemoteRequest, instanceUuid: string): Promise<string> {
  const raw = await remote.request("instance/outputlog", { instanceUuid });
  return typeof raw === "string" ? raw : String(raw ?? "");
}

function resolvePing(pingMap: Map<string, number>, name: string): number | undefined {
  const direct = pingMap.get(name);
  if (direct != null) return direct;
  const key = name.toLowerCase();
  for (const [pn, pv] of pingMap) {
    if (pn.toLowerCase() === key) return pv;
  }
  return undefined;
}

function buildActionCommand(action: PlayerActionType, player: string, reason?: string): string {
  const name = player.trim();
  if (!isValidPlayerName(name)) throw new Error("Invalid player name");
  switch (action) {
    case "op":
      return `op ${name}`;
    case "deop":
      return `deop ${name}`;
    case "kick":
      return reason?.trim() ? `kick ${name} ${reason.trim()}` : `kick ${name}`;
    case "ban":
      return reason?.trim() ? `ban ${name} ${reason.trim()}` : `ban ${name}`;
    case "pardon":
      return `pardon ${name}`;
    case "whitelist_add":
      return `whitelist add ${name}`;
    case "whitelist_remove":
      return `whitelist remove ${name}`;
    case "kill":
      return `kill ${name}`;
    case "clear_inventory":
      return `clear ${name}`;
    case "gamemode_survival":
      return `gamemode survival ${name}`;
    case "gamemode_creative":
      return `gamemode creative ${name}`;
    case "gamemode_spectator":
      return `gamemode spectator ${name}`;
    default:
      throw new Error(`Unsupported player action: ${action}`);
  }
}


function n(v: any): number | undefined {
  if (v == null || v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

async function readMcsmMetricsFile(
  remote: RemoteRequest,
  instanceUuid: string
): Promise<{
  ts?: number;
  tps?: number;
  mspt?: number;
  players: Array<Partial<PlayerRow> & { name: string }>;
  maxPlayers?: number;
  onlineCount?: number;
  rankings?: Rankings;
} | null> {
  try {
    const raw = await remote.request("file/edit", {
      instanceUuid,
      target: "mcsm-metrics.json",
      text: null
    });
    if (raw == null) return null;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || typeof data !== "object") return null;
    const ts = Number((data as any).ts) || 0;
    if (ts && Date.now() - ts > 30_000) return null; // stale
    const perf = (data as any).performance || {};
    const tps = perf?.tps?.s5 != null ? Number(perf.tps.s5) : undefined;
    const mspt = perf?.mspt?.med10s != null ? Number(perf.mspt.med10s) : undefined;
    const list = Array.isArray((data as any).playersOnline) ? (data as any).playersOnline : [];
    const players = list
      .filter((p: any) => p && typeof p.name === "string")
      .map((p: any) => ({
        name: String(p.name),
        uuid: p.uuid ? String(p.uuid) : undefined,
        pingMs: n(p.pingMs) != null ? Math.round(n(p.pingMs)!) : undefined,
        afk: !!p.afk,
        sessionPlayMs: n(p.sessionPlayMs),
        totalPlayMs: n(p.totalPlayMs),
        totalActiveMs: n(p.totalActiveMs),
        totalAfkMs: n(p.totalAfkMs),
        deaths: n(p.deaths),
        playerKills: n(p.playerKills),
        mobKills: n(p.mobKills),
        blocksBroken: n(p.blocksBroken),
        blocksPlaced: n(p.blocksPlaced),
        distanceTotal: n(p.distanceTotal),
        joinCount: n(p.joinCount),
        firstJoin: n(p.firstJoin),
        lastJoin: n(p.lastJoin),
        dim: p.dim ? String(p.dim) : undefined
      }));
    const rankings: Rankings = {};
    const rawRanks = (data as any).rankings;
    if (rawRanks && typeof rawRanks === "object") {
      for (const [k, rows] of Object.entries(rawRanks)) {
        if (!Array.isArray(rows)) continue;
        rankings[k] = rows
          .filter((r: any) => r && r.name)
          .slice(0, 10)
          .map((r: any) => ({
            name: String(r.name),
            uuid: r.uuid ? String(r.uuid) : undefined,
            value: Number(r.value) || 0
          }));
      }
    }
    return {
      ts,
      tps: Number.isFinite(tps as number) ? (tps as number) : undefined,
      mspt: Number.isFinite(mspt as number) ? (mspt as number) : undefined,
      players,
      maxPlayers:
        (data as any).maxPlayers != null ? Number((data as any).maxPlayers) : undefined,
      onlineCount:
        (data as any).playersOnlineCount != null
          ? Number((data as any).playersOnlineCount)
          : players.length,
      rankings
    };
  } catch {
    return null;
  }
}

export async function readPlayerProfile(
  daemonId: string,
  instanceUuid: string,
  playerUuid: string
): Promise<PlayerProfileDetail | null> {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService) throw new Error("Remote daemon not found");
  const remote = new RemoteRequest(remoteService);
  const id = String(playerUuid || "").trim();
  if (!/^[0-9a-fA-F-]{32,36}$/.test(id)) throw new Error("Invalid player uuid");
  try {
    const raw = await remote.request("file/edit", {
      instanceUuid,
      target: `mcsm-metrics/players/${id}.json`,
      text: null
    });
    if (raw == null) return null;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || typeof data !== "object") return null;
    return data as PlayerProfileDetail;
  } catch {
    return null;
  }
}

export async function collectPlayerMonitor(
  daemonId: string,
  instanceUuid: string,
  mode: PlayerMonitorMode = "full"
): Promise<PlayerMonitorSnapshot> {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService) throw new Error("Remote daemon not found");
  const remote = new RemoteRequest(remoteService);

  // Never send console commands when the instance is not running.
  // Otherwise the terminal floods with "instance process does not exist".
  let instanceRunning = false;
  try {
    const detail = await remote.request("instance/detail", { instanceUuid });
    const status = Number((detail as { status?: number } | null)?.status);
    // Daemon: -1 busy, 0 stopped, 1 stopping, 2 starting, 3 running
    instanceRunning = status === 3;
  } catch {
    instanceRunning = false;
  }

  const sources: string[] = [];
  const warnings: string[] = [];

  const [opsRaw, whitelistRaw, cacheRaw] = await Promise.all([
    readInstanceJsonFile(remote, instanceUuid, "ops.json"),
    readInstanceJsonFile(remote, instanceUuid, "whitelist.json"),
    readInstanceJsonFile(remote, instanceUuid, "usercache.json")
  ]);

  const ops = parseNameUuidList(opsRaw);
  const whitelist = parseNameUuidList(whitelistRaw);
  const cache = parseNameUuidList(cacheRaw);
  sources.push("ops.json", "whitelist.json", "usercache.json");

  const opSet = new Set(ops.map((p) => p.name.toLowerCase()));
  const whiteSet = new Set(whitelist.map((p) => p.name.toLowerCase()));
  const uuidByName = new Map<string, string>();
  for (const row of [...ops, ...whitelist, ...cache]) {
    if (row.uuid) uuidByName.set(row.name.toLowerCase(), row.uuid);
  }

  let onlineNames: string[] = [];
  let maxPlayers: number | undefined;
  let onlineCount: number | undefined;
  let sparkAvailable = false;
  let sparkSummary: PlayerMonitorSnapshot["sparkSummary"];
  const pingMap = new Map<string, number>();

  // Prefer companion mod JSON when available (no console spam).
  // If the instance is already stopped, treat everyone as offline even if the
  // last metrics file still lists players.
  const modMetrics = await readMcsmMetricsFile(remote, instanceUuid);
  if (modMetrics) {
    sources.push("file:mcsm-metrics.json");
    onlineNames = instanceRunning ? modMetrics.players.map((p) => p.name) : [];
    onlineCount = instanceRunning
      ? modMetrics.onlineCount ?? onlineNames.length
      : 0;
    maxPlayers = modMetrics.maxPlayers;
    if (instanceRunning) {
      for (const p of modMetrics.players) {
        if (p.pingMs != null) pingMap.set(p.name, p.pingMs);
      }
    }
    if (modMetrics.tps != null || modMetrics.mspt != null) {
      sparkSummary = {
        tps: modMetrics.tps,
        mspt: modMetrics.mspt,
        rawHint: "mcsm_metrics"
      };
    }
    sparkAvailable = true;

    const onlineSetMod = new Set(onlineNames.map((n) => n.toLowerCase()));
    const allNamesMod = new Set<string>();
    for (const n of onlineNames) allNamesMod.add(n);
    for (const row of [...ops, ...whitelist, ...cache]) allNamesMod.add(row.name);
    // Keep known players from last metrics even when offline for rankings/details.
    for (const p of modMetrics.players) allNamesMod.add(p.name);

    const playersMod: PlayerRow[] = [];
    const modByName = new Map(modMetrics.players.map((p) => [p.name.toLowerCase(), p]));
    for (const name of allNamesMod) {
      const key = name.toLowerCase();
      const online = instanceRunning && onlineSetMod.has(key);
      const resolvedPing = online ? resolvePing(pingMap, name) : undefined;
      const mod = modByName.get(key);
      playersMod.push({
        name,
        uuid: mod?.uuid || uuidByName.get(key),
        online,
        pingMs: resolvedPing,
        pingSource: resolvedPing != null ? "mod" : undefined,
        isOp: opSet.has(key),
        isWhitelisted: whiteSet.has(key),
        lastSeen: online ? "online" : undefined,
        afk: online ? mod?.afk : undefined,
        sessionPlayMs: mod?.sessionPlayMs,
        totalPlayMs: mod?.totalPlayMs,
        totalActiveMs: mod?.totalActiveMs,
        totalAfkMs: mod?.totalAfkMs,
        deaths: mod?.deaths,
        playerKills: mod?.playerKills,
        mobKills: mod?.mobKills,
        blocksBroken: mod?.blocksBroken,
        blocksPlaced: mod?.blocksPlaced,
        distanceTotal: mod?.distanceTotal,
        joinCount: mod?.joinCount,
        firstJoin: mod?.firstJoin,
        lastJoin: mod?.lastJoin,
        dim: online ? mod?.dim : undefined
      });
    }
    playersMod.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if ((a.pingMs ?? 99999) !== (b.pingMs ?? 99999)) {
        return (a.pingMs ?? 99999) - (b.pingMs ?? 99999);
      }
      return a.name.localeCompare(b.name);
    });
    const resolvedOnline = onlineCount ?? playersMod.filter((p) => p.online).length;
    const pingHistory = pushPingHistory(daemonId, instanceUuid, playersMod, resolvedOnline);
    return {
      instanceUuid,
      daemonId,
      mode,
      onlineCount: resolvedOnline,
      maxPlayers,
      players: playersMod,
      sparkAvailable: true,
      sparkSummary,
      pingHistory,
      rankings: modMetrics.rankings,
      collectedAt: Date.now(),
      sources,
      warnings: instanceRunning ? [] : ["Instance is not running; showing offline roster only."]
    };
  }

  // No metrics file: only probe console while running.
  if (!instanceRunning) {
    const playersOffline: PlayerRow[] = [];
    const names = new Set<string>();
    for (const row of [...ops, ...whitelist, ...cache]) names.add(row.name);
    for (const name of names) {
      const key = name.toLowerCase();
      playersOffline.push({
        name,
        uuid: uuidByName.get(key),
        online: false,
        isOp: opSet.has(key),
        isWhitelisted: whiteSet.has(key)
      });
    }
    playersOffline.sort((a, b) => a.name.localeCompare(b.name));
    return {
      instanceUuid,
      daemonId,
      mode,
      onlineCount: 0,
      maxPlayers,
      players: playersOffline,
      sparkAvailable: false,
      pingHistory: getPingHistory(daemonId, instanceUuid),
      collectedAt: Date.now(),
      sources,
      warnings: ["Instance is not running; skipped console live probe."]
    };
  }

  try {
    const before = await readOutputLog(remote, instanceUuid);
    const beforeLen = before.length;

    // Always refresh the online roster (cheap enough for silent polling).
    await sendCommand(remote, instanceUuid, "list");
    await sleep(mode === "fast" ? 700 : 1000);

    let mid = await readOutputLog(remote, instanceUuid);
    let midDelta = mid.length > beforeLen ? mid.slice(beforeLen) : mid.slice(-12000);
    sources.push("console:list");

    let listParsed = parseListOutput(midDelta);
    if (listParsed.names.length === 0) listParsed = parseListOutput(mid.slice(-8000));
    onlineNames = listParsed.names;
    maxPlayers = listParsed.maxPlayers;
    onlineCount = listParsed.onlineCount;

    // Console fallback only when companion mod file is missing.
    // We no longer depend on Spark commands.
    if (mode === "full") {
      warnings.push(
        "mcsm_metrics mod file not found. Install mcsm_metrics and restart the instance for live player ping/TPS. Falling back to console list only."
      );
      sources.push("fallback:console-list");
      sparkAvailable = false;
    } else {
      const prev = getPingHistory(daemonId, instanceUuid);
      const lastWithPing = [...prev].reverse().find((p) => p.avg != null);
      sparkAvailable = lastWithPing != null;
      sources.push("mode:fast");
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    warnings.push(`Live probe failed: ${msg}`);
  }

  const onlineSet = new Set(onlineNames.map((n) => n.toLowerCase()));
  const allNames = new Set<string>();
  for (const n of onlineNames) allNames.add(n);
  for (const row of [...ops, ...whitelist, ...cache]) allNames.add(row.name);

  const players: PlayerRow[] = [];
  for (const name of allNames) {
    const key = name.toLowerCase();
    const online = onlineSet.has(key);
    const resolvedPing = resolvePing(pingMap, name);
    players.push({
      name,
      uuid: uuidByName.get(key),
      online,
      pingMs: resolvedPing,
      pingSource: resolvedPing != null ? "mod" : undefined,
      isOp: opSet.has(key),
      isWhitelisted: whiteSet.has(key),
      lastSeen: online ? "online" : undefined
    });
  }

  players.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if ((a.pingMs ?? 99999) !== (b.pingMs ?? 99999)) {
      return (a.pingMs ?? 99999) - (b.pingMs ?? 99999);
    }
    return a.name.localeCompare(b.name);
  });

  const resolvedOnline = onlineCount ?? players.filter((p) => p.online).length;

  // Only append history when we actually sampled pings (full mode), or when
  // fast mode still has online count changes (keeps online series alive).
  let pingHistory = getPingHistory(daemonId, instanceUuid);
  if (mode === "full") {
    pingHistory = pushPingHistory(daemonId, instanceUuid, players, resolvedOnline);
  } else if (mode === "fast") {
    // Carry forward last pings onto current online names for chart continuity.
    const last = pingHistory[pingHistory.length - 1];
    if (last?.byPlayer) {
      for (const p of players) {
        if (!p.online || p.pingMs != null) continue;
        const prevPing = last.byPlayer[p.name];
        if (prevPing != null) {
          p.pingMs = prevPing;
          p.pingSource = "mod";
        }
      }
    }
    // Record online-only points sparsely so the chart x-axis keeps moving.
    const now = Date.now();
    const tooSoon = last && now - last.t < 8_000;
    if (!tooSoon) {
      pingHistory = pushPingHistory(daemonId, instanceUuid, players, resolvedOnline);
    }
  }

  return {
    instanceUuid,
    daemonId,
    mode,
    onlineCount: resolvedOnline,
    maxPlayers,
    players,
    sparkAvailable,
    sparkSummary,
    pingHistory,
    rankings: undefined,
    collectedAt: Date.now(),
    sources,
    warnings
  };
}

export async function runPlayerAction(params: {
  daemonId: string;
  instanceUuid: string;
  action: PlayerActionType;
  player: string;
  reason?: string;
}): Promise<{ ok: true; command: string; message: string }> {
  const remoteService = RemoteServiceSubsystem.getInstance(params.daemonId);
  if (!remoteService) throw new Error("Remote daemon not found");
  const remote = new RemoteRequest(remoteService);
  const command = buildActionCommand(params.action, params.player, params.reason);
  await sendCommand(remote, params.instanceUuid, command);
  return {
    ok: true,
    command,
    message: `Executed: ${command}`
  };
}
