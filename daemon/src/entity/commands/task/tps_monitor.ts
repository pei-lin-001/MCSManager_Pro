import fs from "fs-extra";
import path from "path";
import Instance from "../../instance/instance";
import { ILifeCycleTask } from "../../instance/life_cycle";

export interface TpsSample {
  value: number;
  mspt?: number;
  source?: string;
  time: number;
}

interface ParsedTps {
  tps: number;
  mspt?: number;
  source: string;
  /** True when TPS was derived from MSPT because vendor TPS was capped at 20. */
  derived?: boolean;
}

/**
 * Poll Minecraft server TPS/MSPT from console output.
 *
 * Forge/NeoForge `forge tps` often reports Mean TPS = 20.000 whenever MSPT < 50ms,
 * even under heavy load. That makes the TPS number alone almost useless.
 * We therefore:
 *  1) Prefer companion mod metrics (mcsm-metrics.json) when present
 *  2) Fall back to forge/paper console TPS and always capture MSPT
 *  3) When vendor TPS is capped at 20 but MSPT > 50, derive effective TPS = 1000/MSPT
 */
export default class MinecraftTpsTask implements ILifeCycleTask {
  public status: number = 0;
  public name: string = "MinecraftTps";

  private pollTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private responseTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private dataHandler: ((chunk: string) => void) | null = null;
  private pending = false;
  private lineBuffer = "";
  private history: TpsSample[] = [];
  private instanceRef: Instance | null = null;
  private commandIndex = 0;

  private static readonly POLL_MS = 15_000;
  private static readonly RESPONSE_WAIT_MS = 6_000;
  private static readonly HISTORY_LIMIT = 240; // ~60min @15s

  private strip(text: string): string {
    return String(text || "")
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/§[0-9a-fk-or]/gi, "")
      .replace(/[⚡]/g, "");
  }

  private clampTps(tps: number): number {
    if (!Number.isFinite(tps)) return 0;
    return Math.max(0, Math.min(tps, 20.5));
  }

  private tpsFromMspt(mspt: number): number {
    if (!Number.isFinite(mspt) || mspt <= 0) return 20;
    return this.clampTps(1000 / mspt);
  }

  private parseTpsText(text: string): ParsedTps | null {
    const cleaned = this.strip(text);

    // Spark:
    // TPS from last 5s, 10s, 1m, 5m, 15m:
    //     20.0, 19.8, *20.0, *20.0, *20.0
    const sparkTpsBlock = cleaned.match(
      /TPS from last[^\n]*:\s*\n?\s*([*\d.,\s]+)/i
    );
    // Spark tick durations (median is 2nd value of first group):
    // Tick durations (min/med/95%ile/max ms) from last 10s, 1m:
    //     0.5/0.9/1.3/5.2; 0.5/1.0/16.3/80.5
    const sparkMsptBlock = cleaned.match(
      /Tick durations[^\n]*:\s*\n?\s*([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)/i
    );

    if (sparkTpsBlock) {
      const nums: number[] = [];
      const numRe = /[*]?([\d.]+)/g;
      let nm: RegExpExecArray | null;
      while ((nm = numRe.exec(sparkTpsBlock[1])) != null) {
        const v = Number(nm[1]);
        if (Number.isFinite(v)) nums.push(v);
      }
      const tps5s = nums.find((n) => Number.isFinite(n));
      const mspt =
        sparkMsptBlock && Number.isFinite(Number(sparkMsptBlock[2]))
          ? Number(sparkMsptBlock[2])
          : undefined;

      if (tps5s != null) {
        let tps = this.clampTps(tps5s);
        let derived = false;
        // If spark also shows high median tick but tps still 20, derive.
        if (mspt != null && mspt > 50 && tps >= 19.95) {
          tps = this.tpsFromMspt(mspt);
          derived = true;
        }
        return { tps, mspt, source: "spark", derived };
      }
    }

    if (sparkMsptBlock) {
      const mspt = Number(sparkMsptBlock[2]);
      if (Number.isFinite(mspt)) {
        return {
          tps: this.tpsFromMspt(mspt),
          mspt,
          source: "spark-mspt",
          derived: true
        };
      }
    }

    // Forge / NeoForge overall line:
    // Overall: Mean tick time: 2.345 ms. Mean TPS: 20.000
    const forgeOverall = cleaned.match(
      /Overall:\s*Mean tick time:\s*([\d.]+)\s*ms\.\s*Mean TPS:\s*([\d.]+)/i
    );
    if (forgeOverall) {
      const mspt = Number(forgeOverall[1]);
      const reported = Number(forgeOverall[2]);
      if (!Number.isFinite(reported)) return null;

      // Forge caps Mean TPS at 20 while MSPT < 50. Prefer derived load signal.
      let tps = this.clampTps(reported);
      let derived = false;
      if (Number.isFinite(mspt) && mspt > 0) {
        const fromMspt = this.tpsFromMspt(mspt);
        // If reported is basically 20 but tick is already heavy, use derived.
        if (reported >= 19.95 && mspt >= 25) {
          // Soft warning zone: keep reported but surface real pressure via mspt.
          // When mspt > 50, forge itself should drop tps; still recompute for safety.
          if (mspt > 50) {
            tps = fromMspt;
            derived = true;
          }
        } else if (reported >= 19.95 && mspt > 50) {
          tps = fromMspt;
          derived = true;
        }
      }
      return {
        tps,
        mspt: Number.isFinite(mspt) ? mspt : undefined,
        source: derived ? "forge-derived" : "forge",
        derived
      };
    }

    // Forge dimension lines (fallback if overall missing)
    const forgeDim = cleaned.match(
      /Mean tick time:\s*([\d.]+)\s*ms\.\s*Mean TPS:\s*([\d.]+)/i
    );
    if (forgeDim) {
      const mspt = Number(forgeDim[1]);
      const reported = Number(forgeDim[2]);
      if (!Number.isFinite(reported)) return null;
      let tps = this.clampTps(reported);
      let derived = false;
      if (Number.isFinite(mspt) && mspt > 50 && reported >= 19.95) {
        tps = this.tpsFromMspt(mspt);
        derived = true;
      }
      return {
        tps,
        mspt: Number.isFinite(mspt) ? mspt : undefined,
        source: derived ? "forge-dim-derived" : "forge-dim",
        derived
      };
    }

    // Paper / Purpur / Spigot:
    // TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0
    const paper = cleaned.match(
      /TPS from last[^:]*:\s*[*\s]*([\d.]+)(?:\s*,\s*[*\s]*([\d.]+))?(?:\s*,\s*[*\s]*([\d.]+))?/i
    );
    if (paper) {
      const tps1 = Number(paper[1]);
      if (!Number.isFinite(tps1)) return null;
      return { tps: this.clampTps(tps1), source: "paper" };
    }

    // Generic "TPS: 20.0" / "Current TPS = 19.98"
    const generic = cleaned.match(/(?:current\s+)?TPS\s*[:=]\s*([\d.]+)/i);
    if (generic) {
      const tps = Number(generic[1]);
      if (!Number.isFinite(tps)) return null;
      return { tps: this.clampTps(tps), source: "generic" };
    }

    return null;
  }

  private applySample(instance: Instance, parsed: ParsedTps) {
    const sample: TpsSample = {
      value: Number(parsed.tps.toFixed(2)),
      mspt:
        parsed.mspt != null && Number.isFinite(parsed.mspt)
          ? Number(parsed.mspt.toFixed(2))
          : undefined,
      source: parsed.source,
      time: Date.now()
    };

    this.history.push(sample);
    if (this.history.length > MinecraftTpsTask.HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - MinecraftTpsTask.HISTORY_LIMIT);
    }

    const avg =
      this.history.reduce((sum, item) => sum + item.value, 0) / Math.max(this.history.length, 1);

    // Load percent based on MSPT when available (50ms = 100% of one tick budget).
    const loadPercent =
      sample.mspt != null ? Math.min(Math.max((sample.mspt / 50) * 100, 0), 999) : undefined;

    instance.info = {
      ...instance.info,
      tps: sample.value,
      mspt: sample.mspt,
      tpsAvg: Number(avg.toFixed(2)),
      tpsUpdatedAt: sample.time,
      tpsSource: sample.source,
      tpsLoadPercent: loadPercent != null ? Number(loadPercent.toFixed(1)) : undefined,
      tpsHistory: this.history.map((item) => ({
        value: String(item.value),
        mspt: item.mspt != null ? String(item.mspt) : undefined,
        time: item.time
      }))
    };
  }

  private onData(chunk: string) {
    if (!this.pending || !this.instanceRef) return;
    this.lineBuffer += String(chunk || "");
    if (this.lineBuffer.length > 48_000) {
      this.lineBuffer = this.lineBuffer.slice(-24_000);
    }

    // Prefer waiting a bit for multi-line spark blocks, but accept forge overall immediately.
    const parsed = this.parseTpsText(this.lineBuffer);
    if (!parsed) return;

    // For spark, require either tick durations or a full TPS value line after header.
    if (parsed.source.startsWith("spark") && !/TPS from last|Tick durations/i.test(this.lineBuffer)) {
      return;
    }

    this.applySample(this.instanceRef, parsed);
    this.finishPending();
  }

  private finishPending() {
    this.pending = false;
    this.lineBuffer = "";
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private nextCommands(instance: Instance): string[] {
    const type = String(instance.config.type || "").toLowerCase();
    // Console fallback only (no Spark). Companion mod is preferred elsewhere.
    const forgeFirst = ["forge tps", "tps"];
    const paperFirst = ["tps", "forge tps"];

    if (type.includes("forge") || type.includes("neoforge") || type.includes("mohist")) {
      return forgeFirst;
    }
    if (type.includes("paper") || type.includes("spigot") || type.includes("purpur") || type.includes("bukkit")) {
      return paperFirst;
    }
    return ["tps", "forge tps"];
  }

  private hasCompanionMetrics(instance: Instance): boolean {
    try {
      const cwd = instance.absoluteCwdPath();
      const metricsPath = path.join(cwd, "mcsm-metrics.json");
      if (fs.existsSync(metricsPath)) {
        const st = fs.statSync(metricsPath);
        // Fresh companion output — metrics file task owns the charts.
        if (Date.now() - st.mtimeMs < 30_000) return true;
      }
      // Detect installed companion jar even before first write.
      const modsDir = path.join(cwd, "mods");
      if (fs.existsSync(modsDir)) {
        const names = fs.readdirSync(modsDir);
        if (names.some((n) => /mcsm[_-]?metrics/i.test(n) && n.endsWith(".jar"))) {
          return true;
        }
      }
      const pluginsDir = path.join(cwd, "plugins");
      if (fs.existsSync(pluginsDir)) {
        const names = fs.readdirSync(pluginsDir);
        if (names.some((n) => /mcsm[_-]?metrics/i.test(n) && n.endsWith(".jar"))) {
          return true;
        }
      }
    } catch {
      // treat as no companion
    }
    return false;
  }

  private async requestTps(instance: Instance) {
    if (this.pending) return;
    if (instance.status() !== Instance.STATUS_RUNNING) return;
    if (!instance.process) return;

    // Prefer companion mod metrics. If the companion is not installed, do NOT
    // spam console with tps/forge tps (Fabric vanilla has no such commands).
    if (!this.hasCompanionMetrics(instance)) {
      return;
    }

    try {
      const metricsPath = path.join(instance.absoluteCwdPath(), "mcsm-metrics.json");
      if (fs.existsSync(metricsPath)) {
        const st = fs.statSync(metricsPath);
        if (Date.now() - st.mtimeMs < 10_000) {
          return;
        }
      }
    } catch {
      // companion present but file not ready yet — still avoid console spam
      return;
    }

    // Companion jar exists but metrics file is stale/missing: wait for file task,
    // never fall back to console probes (they pollute Fabric terminals).
    return;
  }

  async start(instance: Instance) {
    const type = String(instance.config.type || "").toLowerCase();
    if (!(type.includes("minecraft/java") || type.includes("universal/mcdr"))) return;

    this.status = 1;
    this.instanceRef = instance;
    this.history = [];
    this.commandIndex = 0;

    this.dataHandler = (chunk: string) => this.onData(chunk);
    instance.process?.on("data", this.dataHandler);

    // First sample soon after start.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.requestTps(instance);
    }, 8_000);

    this.pollTimer = setInterval(() => {
      void this.requestTps(instance);
    }, MinecraftTpsTask.POLL_MS);
  }

  async stop(instance: Instance) {
    this.status = 0;
    this.finishPending();
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.dataHandler && instance.process) {
      instance.process.removeListener("data", this.dataHandler);
    }
    this.dataHandler = null;
    this.instanceRef = null;
    this.history = [];

    instance.info = {
      ...instance.info,
      tps: undefined,
      mspt: undefined,
      tpsAvg: undefined,
      tpsUpdatedAt: undefined,
      tpsSource: undefined,
      tpsLoadPercent: undefined,
      tpsHistory: undefined
    };
  }
}
