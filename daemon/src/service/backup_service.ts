import fs from "fs-extra";
import path from "path";
import archiver from "archiver";
import { createWriteStream } from "fs";
import { decompress } from "../common/compress";
import Instance from "../entity/instance/instance";
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import { $t } from "../i18n";

export type BackupScope = "world" | "core" | "full";
export type BackupStatus = "queued" | "running" | "done" | "failed";
export type BackupTrigger = "manual" | "schedule" | "pre-restore";

export interface BackupRecord {
  id: string;
  instanceUuid: string;
  nickname?: string;
  scope: BackupScope;
  createdAt: number;
  sizeBytes: number;
  status: BackupStatus;
  fileName: string;
  note?: string;
  trigger: BackupTrigger;
  serverWasRunning: boolean;
  error?: string;
  protected?: boolean; // pre-restore not rotated by default keep policy
}

export interface BackupIndex {
  instanceUuid: string;
  keepCount: number; // default 5, user configurable
  items: BackupRecord[];
}

export interface BackupCreateOptions {
  scope?: BackupScope;
  note?: string;
  trigger?: BackupTrigger;
  keepCount?: number;
  protected?: boolean;
}

const BACKUP_ROOT = path.normalize(path.join(process.cwd(), "data", "InstanceBackup"));
const DEFAULT_KEEP = 5;
const MIN_KEEP = 1;
const MAX_KEEP = 50;

const FULL_EXCLUDES = new Set([
  "libraries",
  "versions",
  "logs",
  "crash-reports",
  ".cache",
  "modernfix",
  "DistantHorizons.sqlite",
  "DistantHorizons.sqlite-journal"
]);

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function makeId(scope: BackupScope) {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}_${scope}_${Math.random().toString(36).slice(2, 7)}`;
}

function instanceBackupDir(uuid: string) {
  return path.join(BACKUP_ROOT, uuid);
}

function indexPath(uuid: string) {
  return path.join(instanceBackupDir(uuid), "index.json");
}

async function readIndex(uuid: string): Promise<BackupIndex> {
  const p = indexPath(uuid);
  if (!(await fs.pathExists(p))) {
    return { instanceUuid: uuid, keepCount: DEFAULT_KEEP, items: [] };
  }
  try {
    const raw = await fs.readJson(p);
    return {
      instanceUuid: uuid,
      keepCount: clampKeep(raw.keepCount),
      items: Array.isArray(raw.items) ? raw.items : []
    };
  } catch {
    return { instanceUuid: uuid, keepCount: DEFAULT_KEEP, items: [] };
  }
}

async function writeIndex(idx: BackupIndex) {
  await fs.mkdirs(instanceBackupDir(idx.instanceUuid));
  await fs.writeJson(indexPath(idx.instanceUuid), idx, { spaces: 2 });
}

function clampKeep(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_KEEP;
  return Math.min(MAX_KEEP, Math.max(MIN_KEEP, Math.floor(v)));
}

function isMinecraft(instance: Instance) {
  return String(instance.config.type || "").includes("minecraft");
}

async function listWorldDirs(cwd: string): Promise<string[]> {
  const entries = await fs.readdir(cwd).catch(() => []);
  const worlds: string[] = [];
  for (const name of entries) {
    if (name === "world" || name.startsWith("world_")) {
      const full = path.join(cwd, name);
      try {
        if ((await fs.stat(full)).isDirectory()) worlds.push(name);
      } catch {
        // skip
      }
    }
  }
  // also common custom level-name folders referenced by server.properties
  try {
    const props = await fs.readFile(path.join(cwd, "server.properties"), "utf-8");
    const m = props.match(/^level-name\s*=\s*(.+)$/m);
    if (m) {
      const level = m[1].trim();
      if (level && level !== "world") {
        for (const suffix of ["", "_nether", "_the_end"]) {
          const name = `${level}${suffix}`;
          const full = path.join(cwd, name);
          if (await fs.pathExists(full)) {
            const st = await fs.stat(full);
            if (st.isDirectory() && !worlds.includes(name)) worlds.push(name);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return worlds;
}

const CORE_FILES = [
  "server.properties",
  "ops.json",
  "whitelist.json",
  "banned-players.json",
  "banned-ips.json",
  "eula.txt",
  "bukkit.yml",
  "spigot.yml",
  "paper.yml",
  "purpur.yml",
  "config",
  "configs"
];

async function resolveBackupEntries(
  cwd: string,
  scope: BackupScope
): Promise<Array<{ abs: string; name: string }>> {
  const out: Array<{ abs: string; name: string }> = [];
  const add = async (rel: string) => {
    const abs = path.join(cwd, rel);
    if (await fs.pathExists(abs)) out.push({ abs, name: rel });
  };

  if (scope === "world" || scope === "core") {
    const worlds = await listWorldDirs(cwd);
    for (const w of worlds) await add(w);
  }
  if (scope === "core") {
    for (const f of CORE_FILES) await add(f);
  }
  if (scope === "full") {
    const entries = await fs.readdir(cwd);
    for (const name of entries) {
      if (FULL_EXCLUDES.has(name)) continue;
      if (name.endsWith(".lock")) continue;
      await add(name);
    }
  }
  // de-dupe
  const map = new Map<string, { abs: string; name: string }>();
  for (const e of out) map.set(e.name, e);
  return Array.from(map.values());
}

async function zipEntries(zipPath: string, entries: Array<{ abs: string; name: string }>) {
  await fs.mkdirs(path.dirname(zipPath));
  return new Promise<number>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 5 } });
    let settled = false;
    output.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(archive.pointer());
      }
    });
    output.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    archive.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    archive.pipe(output);
    for (const e of entries) {
      try {
        const st = fs.statSync(e.abs);
        if (st.isDirectory()) archive.directory(e.abs, e.name);
        else if (st.isFile()) archive.file(e.abs, { name: e.name });
      } catch {
        // skip missing
      }
    }
    void archive.finalize();
  });
}

async function applyRetention(idx: BackupIndex) {
  const keep = clampKeep(idx.keepCount);
  idx.keepCount = keep;
  // rotate only non-protected done items, newest first
  const rotatable = idx.items
    .filter((i) => i.status === "done" && !i.protected)
    .sort((a, b) => b.createdAt - a.createdAt);
  const victims = rotatable.slice(keep);
  if (!victims.length) return;
  const victimIds = new Set(victims.map((v) => v.id));
  for (const v of victims) {
    const fp = path.join(instanceBackupDir(idx.instanceUuid), v.fileName);
    await fs.remove(fp).catch(() => undefined);
    await fs.remove(fp.replace(/\.zip$/, ".meta.json")).catch(() => undefined);
  }
  idx.items = idx.items.filter((i) => !victimIds.has(i.id));
}

const running = new Set<string>();

export class BackupService {
  async getSettings(instanceUuid: string) {
    const idx = await readIndex(instanceUuid);
    return { keepCount: idx.keepCount, defaultKeepCount: DEFAULT_KEEP, min: MIN_KEEP, max: MAX_KEEP };
  }

  async setKeepCount(instanceUuid: string, keepCount: number) {
    const idx = await readIndex(instanceUuid);
    idx.keepCount = clampKeep(keepCount);
    await writeIndex(idx);
    await applyRetention(idx);
    await writeIndex(idx);
    return { keepCount: idx.keepCount };
  }

  async list(instanceUuid: string) {
    const idx = await readIndex(instanceUuid);
    // newest first
    const items = [...idx.items].sort((a, b) => b.createdAt - a.createdAt);
    return { keepCount: idx.keepCount, items };
  }

  async create(instanceUuid: string, options: BackupCreateOptions & { bypassLock?: boolean } = {}) {
    if (!options.bypassLock && running.has(instanceUuid)) {
      throw new Error("A backup is already running for this instance");
    }
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (!instance) throw new Error("Instance not found");

    const scope: BackupScope = options.scope || "core";
    if (!["world", "core", "full"].includes(scope)) throw new Error("Invalid backup scope");

    const cwd = instance.absoluteCwdPath();
    if (!(await fs.pathExists(cwd))) throw new Error("Instance working directory not found");

    // free space check (require at least 512MB free)
    try {
      // fs.statfs may not exist on older node; ignore if unavailable
      const statfs = (fs as any).statfsSync || (fs as any).statvfsSync;
      if (typeof (fs as any).statfs === "function") {
        const st = await (fs as any).statfs(cwd);
        const free = Number(st.bavail || st.bfree || 0) * Number(st.bsize || 0);
        if (free > 0 && free < 512 * 1024 * 1024) {
          throw new Error("Insufficient disk space for backup (<512MB free)");
        }
      }
    } catch (e: any) {
      if (String(e?.message || "").includes("Insufficient")) throw e;
    }

    const id = makeId(scope);
    const fileName = `${id}.zip`;
    const dir = instanceBackupDir(instanceUuid);
    await fs.mkdirs(dir);
    const zipPath = path.join(dir, fileName);

    let runningFlag = false;
    try {
      const st = typeof (instance as any).status === "function" ? (instance as any).status() : 0;
      runningFlag = Number(st) === 3; // INSTANCE_STATUS.RUNNING
    } catch {
      runningFlag = false;
    }

    const record: BackupRecord = {
      id,
      instanceUuid,
      nickname: instance.config.nickname,
      scope,
      createdAt: Date.now(),
      sizeBytes: 0,
      status: "running",
      fileName,
      note: options.note || "",
      trigger: options.trigger || "manual",
      serverWasRunning: runningFlag,
      protected: Boolean(options.protected || options.trigger === "pre-restore")
    };

    const idx = await readIndex(instanceUuid);
    if (options.keepCount != null) idx.keepCount = clampKeep(options.keepCount);
    idx.items.unshift(record);
    await writeIndex(idx);

    const holdLock = !options.bypassLock;
    if (holdLock) running.add(instanceUuid);
    try {
      // hot backup: optional save-all for minecraft if running
      if (runningFlag && isMinecraft(instance)) {
        try {
          await instance.execPreset("command", "save-all flush");
          await new Promise((r) => setTimeout(r, 800));
        } catch {
          // ignore command failures for hot backup
        }
      }

      const entries = await resolveBackupEntries(cwd, scope);
      if (!entries.length) throw new Error("Nothing to backup for selected scope");

      const size = await zipEntries(zipPath, entries);
      record.sizeBytes = size;
      record.status = "done";
      await fs.writeJson(path.join(dir, `${id}.meta.json`), record, { spaces: 2 });

      // update index record
      const idx2 = await readIndex(instanceUuid);
      const i = idx2.items.findIndex((x) => x.id === id);
      if (i >= 0) idx2.items[i] = record;
      else idx2.items.unshift(record);
      await applyRetention(idx2);
      await writeIndex(idx2);

      if (runningFlag && isMinecraft(instance)) {
        try {
          await instance.execPreset("command", "save-on");
        } catch {
          // ignore
        }
      }

      logger.info(`[Backup] ${instanceUuid} ${id} done size=${size}`);
      return record;
    } catch (error: any) {
      record.status = "failed";
      record.error = error?.message || String(error);
      await fs.remove(zipPath).catch(() => undefined);
      const idx2 = await readIndex(instanceUuid);
      const i = idx2.items.findIndex((x) => x.id === id);
      if (i >= 0) idx2.items[i] = record;
      await writeIndex(idx2);
      logger.warn(`[Backup] ${instanceUuid} failed`, error);
      throw error;
    } finally {
      if (holdLock) running.delete(instanceUuid);
    }
  }

  async remove(instanceUuid: string, backupId: string) {
    const idx = await readIndex(instanceUuid);
    const item = idx.items.find((x) => x.id === backupId);
    if (!item) throw new Error("Backup not found");
    const fp = path.join(instanceBackupDir(instanceUuid), item.fileName);
    await fs.remove(fp).catch(() => undefined);
    await fs.remove(path.join(instanceBackupDir(instanceUuid), `${backupId}.meta.json`)).catch(() => undefined);
    idx.items = idx.items.filter((x) => x.id !== backupId);
    await writeIndex(idx);
    return true;
  }

  getFilePath(instanceUuid: string, backupId: string) {
    return path.join(instanceBackupDir(instanceUuid), `${backupId}.zip`);
  }

  async restore(
    instanceUuid: string,
    backupId: string,
    options: { autoStart?: boolean; skipPreBackup?: boolean } = {}
  ) {
    if (running.has(instanceUuid)) throw new Error("Backup/restore already running");
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (!instance) throw new Error("Instance not found");
    const idx = await readIndex(instanceUuid);
    const item = idx.items.find((x) => x.id === backupId);
    if (!item || item.status !== "done") throw new Error("Backup not found or not completed");

    const zipPath = path.join(instanceBackupDir(instanceUuid), item.fileName);
    if (!(await fs.pathExists(zipPath))) throw new Error("Backup file missing");

    const cwd = instance.absoluteCwdPath();
    running.add(instanceUuid);
    try {
      // force stop if running
      let wasRunning = false;
      try {
        const st = typeof (instance as any).status === "function" ? (instance as any).status() : 0;
        wasRunning = st === 3;
      } catch {
        wasRunning = false;
      }
      if (wasRunning) {
        try {
          await instance.execPreset("stop");
        } catch {
          try {
            await instance.execPreset("kill");
          } catch {
            // ignore
          }
        }
        // wait up to 60s
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const st = typeof (instance as any).status === "function" ? (instance as any).status() : 0;
          if (st === 0) break;
        }
      }

      if (!options.skipPreBackup) {
        try {
          await this.create(instanceUuid, {
            scope: item.scope,
            note: `pre-restore before ${backupId}`,
            trigger: "pre-restore",
            protected: true,
            bypassLock: true
          });
        } catch (e) {
          logger.warn(`[Backup] pre-restore snapshot failed: ${e}`);
        }
      }

      // decompress to temp then merge
      const tmp = path.join(instanceBackupDir(instanceUuid), `restore_tmp_${Date.now()}`);
      await fs.remove(tmp).catch(() => undefined);
      await fs.mkdirs(tmp);
      await decompress(zipPath, tmp, "utf-8");

      // determine top-level entries from tmp
      const restored = await fs.readdir(tmp);
      for (const name of restored) {
        const src = path.join(tmp, name);
        const dest = path.join(cwd, name);
        await fs.remove(dest).catch(() => undefined);
        await fs.move(src, dest, { overwrite: true });
      }
      await fs.remove(tmp).catch(() => undefined);

      // cleanup locks
      await fs.remove(path.join(cwd, "session.lock")).catch(() => undefined);
      await fs.remove(path.join(cwd, "world", "session.lock")).catch(() => undefined);

      if (options.autoStart || wasRunning) {
        try {
          await instance.execPreset("start");
        } catch (e) {
          logger.warn(`[Backup] autoStart after restore failed: ${e}`);
        }
      }
      return { ok: true, restored: restored.length, backupId };
    } finally {
      running.delete(instanceUuid);
    }
  }
}

const backupService = new BackupService();
export default backupService;
export { DEFAULT_KEEP, clampKeep };
