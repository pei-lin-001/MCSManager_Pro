import fs from "fs-extra";
import os from "os";
import path from "path";
import { ProcessWrapper } from "mcsmanager-common";
import { FRPC_PATH } from "../const";
import { downloadFileToLocalFile } from "./download";
import logger from "./log";
import { TcpTrafficCounterProxy } from "./frp_counter_proxy";
import Instance from "../entity/instance/instance";

export type FrpProvider = "frp" | "openfrp";

export interface FrpGlobalConfig {
  enabled: boolean;
  provider: FrpProvider;
  serverAddr: string;
  serverPort: number;
  authToken: string;
  transport?: string;
  tlsEnable?: boolean;
  openFrpToken?: string;
  frpcPath?: string;
  pricePerGb?: number;
  currency?: string;
}

export interface InstanceTunnelConfig {
  enabled: boolean;
  useGlobal?: boolean;
  provider?: FrpProvider;
  localPort?: number;
  remotePort?: number;
  protocol?: "tcp"; // game port only, tcp first
  openFrpTunnelId?: string;
  openFrpToken?: string;
  // self-hosted overrides
  serverAddr?: string;
  serverPort?: number;
  authToken?: string;
}

export type TunnelRuntimeStatus = "off" | "starting" | "online" | "error";

export interface TunnelRuntimeInfo {
  instanceUuid: string;
  nickname?: string;
  status: TunnelRuntimeStatus;
  provider: FrpProvider;
  localPort: number;
  remotePort?: number;
  publicAddr?: string;
  counterPort?: number;
  rxBytes: number;
  txBytes: number;
  rxRate: number;
  txRate: number;
  lastError?: string;
  updatedAt: number;
}

type RuntimeEntry = {
  instanceUuid: string;
  nickname?: string;
  provider: FrpProvider;
  localPort: number;
  remotePort?: number;
  publicHost?: string;
  configPath?: string;
  process?: ProcessWrapper;
  counter?: TcpTrafficCounterProxy;
  status: TunnelRuntimeStatus;
  lastError?: string;
  lastRx: number;
  lastTx: number;
  lastSampleAt: number;
  rxRate: number;
  txRate: number;
  baselineRx: number;
  baselineTx: number;
};

const WORK_DIR = path.normalize(path.join(process.cwd(), "data", "FrpRuntime"));
const TRAFFIC_DIR = path.normalize(path.join(process.cwd(), "data", "FrpTraffic"));
const GLOBAL_CFG_PATH = path.normalize(path.join(process.cwd(), "data", "Config", "frp_global.json"));

function frpcBinaryName() {
  return `frpc_${os.platform()}_${os.arch()}${os.platform() === "win32" ? ".exe" : ""}`;
}

function defaultFrpcPath() {
  return path.normalize(path.join(process.cwd(), "lib", frpcBinaryName()));
}

function safeId(id: string) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * Resolve the single game listen port for an instance.
 * Priority: explicit tunnel.localPort → basePort → pingConfig.port → first allocated host port → 25565
 */
export function resolveGamePort(instance: Instance, tunnel?: InstanceTunnelConfig): number {
  const explicit = Number(tunnel?.localPort || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);

  const base = Number(instance.config.basePort || 0);
  if (Number.isFinite(base) && base > 0) return Math.floor(base);

  const ping = Number(instance.config.pingConfig?.port || 0);
  if (Number.isFinite(ping) && ping > 0) return Math.floor(ping);

  const allocated = instance.info?.allocatedPorts || [];
  for (const p of allocated) {
    const host = Number(String(p.host || "").split(":")[0] || p.host);
    if (Number.isFinite(host) && host > 0) return Math.floor(host);
  }

  if (String(instance.config.type || "").includes("minecraft")) return 25565;
  return 0;
}

class FrpManager {
  private entries = new Map<string, RuntimeEntry>();
  private sampleTimer?: NodeJS.Timeout;
  private globalConfig: FrpGlobalConfig = {
    enabled: false,
    provider: "frp",
    serverAddr: "",
    serverPort: 7000,
    authToken: "",
    pricePerGb: 0,
    currency: "CNY"
  };

  constructor() {
    fs.mkdirsSync(WORK_DIR);
    fs.mkdirsSync(TRAFFIC_DIR);
    this.loadGlobalConfig();
    this.sampleTimer = setInterval(() => this.sampleAll(), 2000);
  }

  private loadGlobalConfig() {
    try {
      if (fs.existsSync(GLOBAL_CFG_PATH)) {
        const raw = fs.readJsonSync(GLOBAL_CFG_PATH);
        this.globalConfig = { ...this.globalConfig, ...raw };
      }
    } catch {
      // ignore corrupt config
    }
  }

  private saveGlobalConfig() {
    try {
      fs.mkdirsSync(path.dirname(GLOBAL_CFG_PATH));
      fs.writeJsonSync(GLOBAL_CFG_PATH, this.globalConfig, { spaces: 2 });
    } catch (e) {
      logger.warn("[FRP] save global config failed", e);
    }
  }

  setGlobalConfig(cfg: Partial<FrpGlobalConfig>) {
    this.globalConfig = {
      ...this.globalConfig,
      ...cfg,
      serverPort: Number(cfg.serverPort ?? this.globalConfig.serverPort) || 7000,
      enabled: cfg.enabled != null ? Boolean(cfg.enabled) : this.globalConfig.enabled,
      provider: (cfg.provider as FrpProvider) || this.globalConfig.provider
    };
    this.saveGlobalConfig();
  }

  getGlobalConfig(): FrpGlobalConfig {
    return { ...this.globalConfig, authToken: this.globalConfig.authToken };
  }

  getPublicGlobalConfig() {
    const c = this.globalConfig;
    return {
      enabled: Boolean(c.enabled),
      provider: c.provider || "frp",
      serverAddr: c.serverAddr || "",
      serverPort: Number(c.serverPort) || 7000,
      hasAuthToken: Boolean(c.authToken),
      transport: c.transport || "tcp",
      tlsEnable: Boolean(c.tlsEnable),
      hasOpenFrpToken: Boolean(c.openFrpToken),
      pricePerGb: Number(c.pricePerGb) || 0,
      currency: c.currency || "CNY"
    };
  }

  list(): TunnelRuntimeInfo[] {
    return Array.from(this.entries.values()).map((e) => this.toInfo(e));
  }

  get(instanceUuid: string): TunnelRuntimeInfo | null {
    const e = this.entries.get(instanceUuid);
    return e ? this.toInfo(e) : null;
  }

  private toInfo(e: RuntimeEntry): TunnelRuntimeInfo {
    const snap = e.counter?.snapshot();
    const rx = (snap?.rxBytes || 0) + e.baselineRx;
    const tx = (snap?.txBytes || 0) + e.baselineTx;
    const host = e.publicHost || this.globalConfig.serverAddr;
    return {
      instanceUuid: e.instanceUuid,
      nickname: e.nickname,
      status: e.status,
      provider: e.provider,
      localPort: e.localPort,
      remotePort: e.remotePort,
      publicAddr: e.remotePort && host ? `${host}:${e.remotePort}` : undefined,
      counterPort: e.counter ? (e as any).counterPort || undefined : undefined,
      rxBytes: rx,
      txBytes: tx,
      rxRate: e.rxRate,
      txRate: e.txRate,
      lastError: e.lastError,
      updatedAt: Date.now()
    };
  }

  private async ensureFrpcBinary(customPath?: string): Promise<string> {
    const p = customPath || defaultFrpcPath();
    if (fs.existsSync(p)) return p;
    // try shared FRPC_PATH constant
    if (fs.existsSync(FRPC_PATH)) return FRPC_PATH;
    const name = frpcBinaryName();
    const url = `https://mcsmanager.oss-cn-guangzhou.aliyuncs.com/${name}`;
    logger.info(`[FRP] downloading frpc: ${url}`);
    await downloadFileToLocalFile(url, p);
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      // ignore on windows
    }
    return p;
  }

  private readTunnelConfig(instance: Instance): InstanceTunnelConfig {
    const extra: any = instance.config.extraServiceConfig || {};
    return {
      enabled: Boolean(extra.tunnelEnabled || extra.isOpenFrp),
      useGlobal: extra.tunnelUseGlobal !== false,
      provider: (extra.tunnelProvider as FrpProvider) || undefined,
      localPort: Number(extra.tunnelLocalPort || 0) || undefined,
      remotePort: Number(extra.tunnelRemotePort || 0) || undefined,
      protocol: "tcp",
      openFrpTunnelId: extra.openFrpTunnelId || "",
      openFrpToken: extra.openFrpToken || "",
      serverAddr: extra.tunnelServerAddr || "",
      serverPort: Number(extra.tunnelServerPort || 0) || undefined,
      authToken: extra.tunnelAuthToken || ""
    };
  }

  async startForInstance(instance: Instance) {
    const tunnel = this.readTunnelConfig(instance);
    if (!tunnel.enabled) return;
    if (!this.globalConfig.enabled && tunnel.useGlobal !== false && !tunnel.serverAddr) {
      // global disabled and no override
      return;
    }

    const provider: FrpProvider =
      tunnel.provider ||
      (tunnel.openFrpTunnelId ? "openfrp" : this.globalConfig.provider || "frp");

    const localPort = resolveGamePort(instance, tunnel);
    if (!localPort) {
      logger.warn(`[FRP] ${instance.instanceUuid} no game port resolved, skip tunnel`);
      return;
    }

    // stop previous
    await this.stopForInstance(instance.instanceUuid);

    const entry: RuntimeEntry = {
      instanceUuid: instance.instanceUuid,
      nickname: instance.config.nickname,
      provider,
      localPort,
      remotePort: tunnel.remotePort || localPort,
      publicHost: tunnel.serverAddr || this.globalConfig.serverAddr,
      status: "starting",
      lastRx: 0,
      lastTx: 0,
      lastSampleAt: Date.now(),
      rxRate: 0,
      txRate: 0,
      baselineRx: 0,
      baselineTx: 0
    };
    this.entries.set(instance.instanceUuid, entry);
    this.applyTunnelInfo(instance, entry);

    try {
      if (provider === "openfrp") {
        await this.startOpenFrp(instance, entry, tunnel);
      } else {
        await this.startNativeFrp(instance, entry, tunnel);
      }
      entry.status = "online";
      entry.lastError = undefined;
      this.applyTunnelInfo(instance, entry);
      instance.println("FRP", `Tunnel online local=${entry.localPort} remote=${entry.remotePort}`);
    } catch (error: any) {
      entry.status = "error";
      entry.lastError = error?.message || String(error);
      this.applyTunnelInfo(instance, entry);
      instance.println("FRP", `Tunnel start failed: ${entry.lastError}`);
      logger.warn(`[FRP] start failed ${instance.instanceUuid}`, error);
    }
  }

  private applyTunnelInfo(instance: Instance, entry: RuntimeEntry) {
    const info = this.toInfo(entry);
    (instance.info as any).tunnel = info;
    (instance.info as any).openFrpStatus = info.status === "online";
  }

  private async startNativeFrp(
    instance: Instance,
    entry: RuntimeEntry,
    tunnel: InstanceTunnelConfig
  ) {
    const serverAddr = tunnel.serverAddr || this.globalConfig.serverAddr;
    const serverPort = Number(tunnel.serverPort || this.globalConfig.serverPort || 7000);
    const authToken = tunnel.authToken || this.globalConfig.authToken || "";
    if (!serverAddr) throw new Error("FRP serverAddr is empty");

    // High precision: frpc -> counter proxy -> game port
    const counter = new TcpTrafficCounterProxy("127.0.0.1", entry.localPort);
    const counterPort = await counter.start();
    entry.counter = counter;
    (entry as any).counterPort = counterPort;

    const remotePort = entry.remotePort || entry.localPort;
    entry.remotePort = remotePort;
    entry.publicHost = serverAddr;

    const confName = `${safeId(instance.instanceUuid)}.toml`;
    const confPath = path.join(WORK_DIR, confName);
    const proxyName = `mcsm_${safeId(instance.instanceUuid)}`;
    const toml = [
      `serverAddr = "${serverAddr}"`,
      `serverPort = ${serverPort}`,
      authToken ? `auth.token = "${authToken.replace(/"/g, '\\"')}"` : "",
      this.globalConfig.tlsEnable ? `transport.tls.enable = true` : "",
      "",
      `[[proxies]]`,
      `name = "${proxyName}"`,
      `type = "tcp"`,
      `localIP = "127.0.0.1"`,
      `localPort = ${counterPort}`,
      `remotePort = ${remotePort}`,
      ""
    ]
      .filter((l) => l !== "")
      .join("\n");

    await fs.writeFile(confPath, toml, "utf-8");
    entry.configPath = confPath;

    const bin = await this.ensureFrpcBinary(this.globalConfig.frpcPath);
    const proc = new ProcessWrapper(bin, ["-c", confPath], path.dirname(bin), 0, "utf-8");
    entry.process = proc;

    proc.on("exit", () => {
      const cur = this.entries.get(instance.instanceUuid);
      if (cur && cur.process === proc) {
        cur.status = "error";
        cur.lastError = "frpc exited";
        this.applyTunnelInfo(instance, cur);
      }
    });
    proc.on("data", (text: string) => {
      // keep light; only surface errors
      if (/error|failed|login to server failed/i.test(text)) {
        logger.warn(`[FRP][${instance.instanceUuid}] ${String(text).trim()}`);
      }
    });

    // ProcessWrapper.start rejects on non-zero exit; for long-running we only care pid exists.
    // Start without awaiting exit: fire and check pid.
    void proc.start().catch(() => {
      // exit handler covers status
    });
    await new Promise((r) => setTimeout(r, 200));
    if (!proc.getPid()) throw new Error("frpc pid is null");
  }

  private async startOpenFrp(
    instance: Instance,
    entry: RuntimeEntry,
    tunnel: InstanceTunnelConfig
  ) {
    const token = tunnel.openFrpToken || this.globalConfig.openFrpToken || "";
    const tunnelId = tunnel.openFrpTunnelId || "";
    if (!token || !tunnelId) throw new Error("OpenFRP token/tunnelId required");

    // Still insert counter if we can know local game port; OpenFRP remote mapping is cloud-side.
    // Without local rewrite of their tunnel target we cannot force counter path.
    // Count best-effort via optional local proxy only when user points tunnel to counter — skip for now.
    // For openfrp we mark traffic source as unavailable for high precision unless they map to counterPort.
    // Provide counter on localPort+offset? Can't change cloud tunnel target from here.
    // Leave counter absent; rates stay 0 unless later OpenFRP API is added.
    entry.provider = "openfrp";

    const bin = await this.ensureFrpcBinary(this.globalConfig.frpcPath);
    // OpenFRP custom frpc uses -u -p
    const proc = new ProcessWrapper(bin, ["-u", token, "-p", tunnelId], path.dirname(bin), 0, "utf-8");
    entry.process = proc;
    proc.on("exit", () => {
      const cur = this.entries.get(instance.instanceUuid);
      if (cur && cur.process === proc) {
        cur.status = "error";
        cur.lastError = "openfrp frpc exited";
        this.applyTunnelInfo(instance, cur);
      }
    });
    void proc.start().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    if (!proc.getPid()) throw new Error("openfrp frpc pid is null");
  }

  async stopForInstance(instanceUuid: string) {
    const entry = this.entries.get(instanceUuid);
    if (!entry) return;
    try {
      entry.process?.kill();
    } catch {
      // ignore
    }
    try {
      await entry.counter?.stop();
    } catch {
      // ignore
    }
    if (entry.configPath) {
      try {
        await fs.remove(entry.configPath);
      } catch {
        // ignore
      }
    }
    // persist final counters into monthly aggregate before drop
    this.persistSample(entry, true);
    this.entries.delete(instanceUuid);
  }

  private sampleAll() {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      const snap = entry.counter?.snapshot();
      const rx = (snap?.rxBytes || 0) + entry.baselineRx;
      const tx = (snap?.txBytes || 0) + entry.baselineTx;
      const dt = Math.max(0.001, (now - entry.lastSampleAt) / 1000);
      entry.rxRate = Math.max(0, (rx - entry.lastRx) / dt);
      entry.txRate = Math.max(0, (tx - entry.lastTx) / dt);
      entry.lastRx = rx;
      entry.lastTx = tx;
      entry.lastSampleAt = now;
      this.persistSample(entry, false);
    }
  }

  private persistSample(entry: RuntimeEntry, force: boolean) {
    const snap = entry.counter?.snapshot();
    if (!snap && entry.provider === "openfrp") return;
    const rx = (snap?.rxBytes || 0) + entry.baselineRx;
    const tx = (snap?.txBytes || 0) + entry.baselineTx;
    const now = Date.now();
    // minute file for history
    const minute = Math.floor(now / 60000) * 60000;
    const file = path.join(TRAFFIC_DIR, "series", `${safeId(entry.instanceUuid)}.jsonl`);
    if (!force) {
      // write at most every 10s
      const key = `_lastWrite_${entry.instanceUuid}`;
      const last = (this as any)[key] || 0;
      if (now - last < 10000) return;
      (this as any)[key] = now;
    }
    fs.mkdirsSync(path.dirname(file));
    const line =
      JSON.stringify({
        t: now,
        minute,
        instanceUuid: entry.instanceUuid,
        rxBytes: rx,
        txBytes: tx,
        rxRate: entry.rxRate,
        txRate: entry.txRate,
        status: entry.status,
        localPort: entry.localPort,
        remotePort: entry.remotePort
      }) + "\n";
    fs.appendFile(file, line).catch(() => undefined);

    // monthly totals snapshot
    const mfile = path.join(TRAFFIC_DIR, "monthly", `${monthKey(now)}.json`);
    fs.mkdirsSync(path.dirname(mfile));
    let monthly: any = {};
    try {
      if (fs.existsSync(mfile)) monthly = fs.readJsonSync(mfile);
    } catch {
      monthly = {};
    }
    const prev = monthly[entry.instanceUuid] || { rxBytes: 0, txBytes: 0 };
    // store max cumulative observed this month for this process lifetime is incomplete across restarts;
    // keep max of previous and current absolute counters from this runtime only is wrong after restart.
    // Better: store deltas. For v1 keep last absolute + totalDelta field.
    const lastAbs = prev._abs || { rx: 0, tx: 0 };
    let dRx = rx - Number(lastAbs.rx || 0);
    let dTx = tx - Number(lastAbs.tx || 0);
    if (dRx < 0) dRx = rx; // counter reset
    if (dTx < 0) dTx = tx;
    monthly[entry.instanceUuid] = {
      rxBytes: Number(prev.rxBytes || 0) + dRx,
      txBytes: Number(prev.txBytes || 0) + dTx,
      nickname: entry.nickname,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      updatedAt: now,
      _abs: { rx, tx }
    };
    // also day
    const dfile = path.join(TRAFFIC_DIR, "daily", `${dayKey(now)}.json`);
    fs.mkdirsSync(path.dirname(dfile));
    let daily: any = {};
    try {
      if (fs.existsSync(dfile)) daily = fs.readJsonSync(dfile);
    } catch {
      daily = {};
    }
    const dprev = daily[entry.instanceUuid] || { rxBytes: 0, txBytes: 0, _abs: { rx: 0, tx: 0 } };
    const dLast = dprev._abs || { rx: 0, tx: 0 };
    let ddRx = rx - Number(dLast.rx || 0);
    let ddTx = tx - Number(dLast.tx || 0);
    if (ddRx < 0) ddRx = rx;
    if (ddTx < 0) ddTx = tx;
    daily[entry.instanceUuid] = {
      rxBytes: Number(dprev.rxBytes || 0) + ddRx,
      txBytes: Number(dprev.txBytes || 0) + ddTx,
      nickname: entry.nickname,
      updatedAt: now,
      _abs: { rx, tx }
    };
    fs.writeJson(mfile, monthly, { spaces: 2 }).catch(() => undefined);
    fs.writeJson(dfile, daily, { spaces: 2 }).catch(() => undefined);
  }

  getTrafficSummary() {
    const now = Date.now();
    const live = this.list();
    let liveRxRate = 0;
    let liveTxRate = 0;
    let online = 0;
    let error = 0;
    for (const t of live) {
      liveRxRate += t.rxRate || 0;
      liveTxRate += t.txRate || 0;
      if (t.status === "online") online++;
      if (t.status === "error") error++;
    }

    const readAgg = (file: string) => {
      try {
        if (!fs.existsSync(file)) return { rxBytes: 0, txBytes: 0, byInstance: [] as any[] };
        const obj = fs.readJsonSync(file);
        let rx = 0;
        let tx = 0;
        const byInstance: any[] = [];
        for (const [uuid, v] of Object.entries(obj || {})) {
          const row: any = v;
          rx += Number(row.rxBytes || 0);
          tx += Number(row.txBytes || 0);
          byInstance.push({
            instanceUuid: uuid,
            nickname: row.nickname,
            rxBytes: Number(row.rxBytes || 0),
            txBytes: Number(row.txBytes || 0),
            totalBytes: Number(row.rxBytes || 0) + Number(row.txBytes || 0),
            localPort: row.localPort,
            remotePort: row.remotePort,
            updatedAt: row.updatedAt
          });
        }
        byInstance.sort((a, b) => b.totalBytes - a.totalBytes);
        return { rxBytes: rx, txBytes: tx, byInstance };
      } catch {
        return { rxBytes: 0, txBytes: 0, byInstance: [] as any[] };
      }
    };

    const today = readAgg(path.join(TRAFFIC_DIR, "daily", `${dayKey(now)}.json`));
    const month = readAgg(path.join(TRAFFIC_DIR, "monthly", `${monthKey(now)}.json`));
    const price = Number(this.globalConfig.pricePerGb || 0);
    const monthGb = (month.rxBytes + month.txBytes) / (1024 * 1024 * 1024);
    const todayGb = (today.rxBytes + today.txBytes) / (1024 * 1024 * 1024);

    return {
      enabled: Boolean(this.globalConfig.enabled),
      online,
      error,
      totalTunnels: live.length,
      liveRxRate,
      liveTxRate,
      today,
      month,
      estimate: {
        currency: this.globalConfig.currency || "CNY",
        pricePerGb: price,
        todayCost: todayGb * price,
        monthCost: monthGb * price
      },
      tunnels: live,
      updatedAt: now
    };
  }

  getInstanceSeries(instanceUuid: string, limit = 120) {
    const file = path.join(TRAFFIC_DIR, "series", `${safeId(instanceUuid)}.jsonl`);
    if (!fs.existsSync(file)) return [];
    try {
      const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
      const slice = lines.slice(-Math.max(1, Math.min(limit, 2000)));
      return slice.map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}

const frpManager = new FrpManager();
export default frpManager;
