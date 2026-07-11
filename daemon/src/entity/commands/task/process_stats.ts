import fs from "fs";
import os from "os";
import pidusage from "pidusage";
import Instance from "../../instance/instance";
import { ILifeCycleTask } from "../../instance/life_cycle";

type UsageMap = Record<
  string,
  {
    cpu: number;
    memory: number;
    pid: number;
  }
>;

/**
 * Sample host-process CPU/memory for general (non-Docker) instances.
 *
 * PTY mode wraps the real game process:
 *   pty_linux_x64 -> sh ./run.sh -> java ...
 * The instance adapter PID is usually the shell, which is nearly idle.
 * We aggregate the whole process tree under that PID so CPU/memory reflect
 * the real workload (e.g. the Java server process).
 */
export type ResourceSample = {
  t: number;
  cpu?: number;
  mem?: number;
  memBytes?: number;
};

export default class ProcessStatsTask implements ILifeCycleTask {
  public status: number = 0;
  public name: string = "ProcessStats";

  private task: NodeJS.Timeout | null = null;
  private warmTask: NodeJS.Timeout | null = null;
  private isUpdating = false;
  private history: ResourceSample[] = [];
  private static readonly HISTORY_LIMIT = 1200; // ~60min @3s

  private resolveRootPid(instance: Instance): number | null {
    const raw = instance.process?.pid;
    if (raw == null || raw === "") return null;
    const pid = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  }

  private listChildPids(parentPid: number): number[] {
    const children: number[] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return children;
    }

    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
        const match = status.match(/^PPid:\s+(\d+)/m);
        if (match && Number(match[1]) === parentPid) {
          children.push(Number(entry));
        }
      } catch {
        // process may disappear while scanning
      }
    }
    return children;
  }

  private collectProcessTree(rootPid: number): number[] {
    const result: number[] = [];
    const stack = [rootPid];
    const seen = new Set<number>();

    while (stack.length > 0) {
      const pid = stack.pop() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      result.push(pid);
      for (const child of this.listChildPids(pid)) {
        if (!seen.has(child)) stack.push(child);
      }
    }
    return result;
  }

  private async sampleTree(rootPid: number): Promise<{
    cpuUsage: number;
    memoryUsage: number;
    primaryPid: number;
  } | null> {
    const pids = this.collectProcessTree(rootPid);
    if (pids.length === 0) return null;

    let usageMap: UsageMap = {};
    try {
      usageMap = ((await pidusage(pids)) as UsageMap) || {};
    } catch {
      try {
        const one = (await pidusage(rootPid)) as {
          cpu: number;
          memory: number;
          pid: number;
        };
        usageMap = { [String(rootPid)]: one };
      } catch {
        return null;
      }
    }

    let cpuUsage = 0;
    let memoryUsage = 0;
    let primaryPid = rootPid;
    let primaryScore = -1;

    for (const pid of pids) {
      const item = usageMap[String(pid)];
      if (!item) continue;
      const cpu = Number(item.cpu) || 0;
      const memory = Number(item.memory) || 0;
      cpuUsage += cpu;
      memoryUsage += memory;

      // Prefer the heaviest process (usually java) as displayed PID.
      const score = memory * 10 + cpu;
      if (score > primaryScore) {
        primaryScore = score;
        primaryPid = Number(item.pid) || pid;
      }
    }

    // pidusage CPU is percent of one core (can exceed 100 on multi-core).
    // Normalize by host core count so the UI stays in a readable 0-100 range.
    const cores = Math.max(1, os.cpus().length || 1);
    const normalizedCpu = Math.max(0, Math.min(100, Math.round(cpuUsage / cores)));

    return {
      cpuUsage: normalizedCpu,
      memoryUsage,
      primaryPid
    };
  }

  private async updateStats(instance: Instance) {
    if (this.isUpdating) return;
    this.isUpdating = true;

    try {
      if (instance.config.processType === "docker") return;

      const rootPid = this.resolveRootPid(instance);
      if (!rootPid) return;

      const sample = await this.sampleTree(rootPid);
      if (!sample) return;

      const hostMem = os.totalmem();
      const memoryUsagePercent =
        hostMem > 0 ? Math.min(Math.ceil((sample.memoryUsage / hostMem) * 100), 100) : 0;

      this.history.push({
        t: Date.now(),
        cpu: sample.cpuUsage,
        mem: memoryUsagePercent,
        memBytes: sample.memoryUsage
      });
      if (this.history.length > ProcessStatsTask.HISTORY_LIMIT) {
        this.history.splice(0, this.history.length - ProcessStatsTask.HISTORY_LIMIT);
      }

      instance.info = {
        ...instance.info,
        cpuUsage: sample.cpuUsage,
        memoryUsage: sample.memoryUsage,
        memoryLimit: undefined,
        memoryUsagePercent,
        processPid: sample.primaryPid,
        startedAt: instance.startTimestamp || undefined,
        resourceHistory: this.history.map((h) => ({
          t: h.t,
          cpu: h.cpu != null ? String(h.cpu) : undefined,
          mem: h.mem != null ? String(h.mem) : undefined,
          memBytes: h.memBytes != null ? String(h.memBytes) : undefined
        }))
      };
    } catch {
      // Process may have exited between ticks; ignore sampling errors.
    } finally {
      this.isUpdating = false;
    }
  }

  async start(instance: Instance) {
    if (instance.config.processType === "docker") return;
    this.history = [];

    // Immediate sample + a short warm-up sample.
    // pidusage often returns 0 on the first measurement (no baseline yet).
    void this.updateStats(instance);
    this.warmTask = setTimeout(() => {
      void this.updateStats(instance);
    }, 1200);

    this.task = setInterval(() => {
      void this.updateStats(instance);
    }, 3000);
  }

  async stop(instance: Instance) {
    if (this.task) {
      clearInterval(this.task);
      this.task = null;
    }
    if (this.warmTask) {
      clearTimeout(this.warmTask);
      this.warmTask = null;
    }
    this.isUpdating = false;

    this.history = [];
    instance.info = {
      ...instance.info,
      cpuUsage: undefined,
      memoryUsage: undefined,
      memoryLimit: undefined,
      memoryUsagePercent: undefined,
      processPid: undefined,
      startedAt: undefined,
      resourceHistory: undefined
    };
  }
}
