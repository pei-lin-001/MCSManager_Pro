import axios from "axios";
import { execFile } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { extract } from "tar";
import { URL } from "url";
import { promisify } from "util";
import StorageSubsystem from "../common/system_storage";
import { JavaInfo } from "../entity/commands/java/java_manager";
import { globalConfiguration } from "../entity/config";
import { $t } from "../i18n";
import downloadManager from "./download_manager";
import logger from "./log";
import FileManager from "./system_file";
import InstanceSubsystem from "./system_instance";

const execFileAsync = promisify(execFile);

export type EnsureJavaSource = "managed" | "system" | "downloaded";

export interface EnsureJavaResult {
  id: string;
  version: number;
  source: EnsureJavaSource;
  command: string;
  hostMemoryMb: number;
  hostFreeMemoryMb: number;
}

async function sleep(ms: number): Promise<void> {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  setTimeout(resolve, ms);
  return promise;
}

class JavaManager {
  private javaDataDir = "";
  public readonly javaList = new Map<string, IJavaRuntime>();

  constructor() {
    let javaDataDir = path.join(process.cwd(), "data/JavaData");
    if (globalConfiguration.config.defaultJavaDataPath) {
      javaDataDir = path.normalize(globalConfiguration.config.defaultJavaDataPath);
    }
    if (!fs.existsSync(javaDataDir)) fs.mkdirsSync(javaDataDir);
    this.javaDataDir = path.normalize(javaDataDir);

    this.loadJavaList();
  }

  public getJavaDataDir() {
    return this.javaDataDir;
  }

  async loadJavaList() {
    for (const file of await fs.readdir(this.javaDataDir)) {
      const javaPath = path.join(this.javaDataDir, file);
      const dir = await fs.stat(javaPath);
      if (!dir.isDirectory()) continue;

      const infoPath = path.join(javaPath, "java_info.json");
      if (!fs.existsSync(infoPath)) continue;

      const config = await fs.readJson(infoPath);
      // Delete java not yet fully downloaded
      if (config.downloading) {
        await fs.remove(javaPath);
        continue;
      }

      const info = new JavaInfo(config.name, config.installTime ?? Date.now(), config.version);
      info.path = config.path;
      this.javaList.set(info.fullname, {
        info: info,
        path: javaPath,
        usingInstances: []
      });
    }
  }

  list() {
    return Array.from(this.javaList.values());
  }

  getJava(id: string) {
    return this.javaList.get(id);
  }

  exists(id: string) {
    return this.javaList.has(id);
  }

  async getJavaDownloadUrl(info: JavaInfo) {
    switch (info.name) {
      case "zulu": {
        let platform: string = os.platform();

        // In some cases, using win32 will download macosx package
        // Therefore, change platform to windows
        switch (platform) {
          case "win32": {
            platform = "windows";
            break;
          }
        }

        const url =
          "https://api.azul.com/metadata/v1/zulu/packages/?java_package_type=jdk&javafx_bundled=true&release_status=ga&availability_types=CA&certifications=tck&page=1&page_size=2" +
          `&java_version=${info.version}&os=${platform}&arch=${os.arch()}`;
        const response = await axios.get(url, {
          timeout: 1000 * 3
        });

        const data = response.data;
        if (!data) return;

        const javaPackage = data.find(
          (p: any) => p.name.endsWith(".zip") || p.name.endsWith(".tar.gz")
        );
        if (!javaPackage) return;

        const downloadUrl = javaPackage.download_url;
        if (!downloadUrl) return;

        return downloadUrl;
      }
    }
  }

  addJava(info: JavaInfo) {
    const javaPath = path.join(this.javaDataDir, info.fullname);
    if (!fs.existsSync(javaPath)) fs.mkdirsSync(javaPath);

    StorageSubsystem.store(`JavaData/${info.fullname}`, "java_info", {
      name: info.name,
      path: info.path,
      version: info.version,
      installTime: info.installTime,
      downloading: Boolean(info.downloading)
    });

    this.javaList.set(info.fullname, {
      info: info,
      path: javaPath,
      usingInstances: []
    });
  }

  updateJavaInfo(info: JavaInfo) {
    const javaPath = path.join(this.javaDataDir, info.fullname);
    if (!fs.existsSync(javaPath)) return;

    StorageSubsystem.store(`JavaData/${info.fullname}`, "java_info", {
      name: info.name,
      path: info.path,
      version: info.version,
      installTime: info.installTime,
      downloading: Boolean(info.downloading)
    });
  }

  private hostMemorySnapshot(): { hostMemoryMb: number; hostFreeMemoryMb: number } {
    return {
      hostMemoryMb: Math.floor(os.totalmem() / 1024 / 1024),
      hostFreeMemoryMb: Math.floor(os.freemem() / 1024 / 1024)
    };
  }

  private parseMajorVersion(raw?: string): number | null {
    if (!raw) return null;
    const text = String(raw).trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    const match = text.match(/(?:^|[_\-.])((?:1\.)?(\d{1,2}))(?:$|[_\-.])/);
    if (!match) return null;
    if (match[1].startsWith("1.")) return Number(match[2]);
    return Number(match[1]);
  }

  private runtimeMajor(runtime: IJavaRuntime): number | null {
    const info = runtime.info as IJavaInfo & { version?: string; name?: string; fullname?: string };
    return (
      this.parseMajorVersion(info.version) ||
      this.parseMajorVersion(info.fullname) ||
      this.parseMajorVersion(info.name)
    );
  }

  private async javaBinaryExists(javaHome: string): Promise<boolean> {
    const bin = path.join(javaHome, "bin", os.platform() === "win32" ? "java.exe" : "java");
    return fs.pathExists(bin);
  }

  private async detectSystemJavaHome(version: number): Promise<string | null> {
    const candidates: string[] = [];
    if (os.platform() === "linux") {
      candidates.push(
        `/usr/lib/jvm/java-${version}-openjdk-amd64`,
        `/usr/lib/jvm/java-${version}-openjdk`,
        `/usr/lib/jvm/java-${version}-temurin`,
        `/usr/lib/jvm/temurin-${version}-jdk`,
        `/usr/lib/jvm/zulu-${version}`,
        `/usr/lib/jvm/zulu${version}`
      );
      try {
        const jvmRoot = "/usr/lib/jvm";
        if (await fs.pathExists(jvmRoot)) {
          const entries = await fs.readdir(jvmRoot);
          for (const entry of entries) {
            if (entry.includes(String(version))) {
              candidates.push(path.join(jvmRoot, entry));
            }
          }
        }
      } catch {
        // ignore scan failures
      }
    } else if (os.platform() === "darwin") {
      candidates.push(`/Library/Java/JavaVirtualMachines/temurin-${version}.jdk/Contents/Home`);
      candidates.push(`/Library/Java/JavaVirtualMachines/zulu-${version}.jdk/Contents/Home`);
    } else if (os.platform() === "win32") {
      candidates.push(`C:\\Program Files\\Eclipse Adoptium\\jdk-${version}`);
      candidates.push(`C:\\Program Files\\Zulu\\zulu-${version}`);
    }

    const seen = new Set<string>();
    for (const home of candidates) {
      const normalized = path.normalize(home);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (await this.javaBinaryExists(normalized)) return normalized;
    }
    return null;
  }

  private findManagedJava(version: number): IJavaRuntime | null {
    for (const runtime of this.javaList.values()) {
      if (runtime.info.downloading) continue;
      const major = this.runtimeMajor(runtime);
      if (major === version) return runtime;
    }
    return null;
  }

  private async installManagedJava(version: number): Promise<IJavaRuntime> {
    const info = new JavaInfo("zulu", Date.now(), String(version));
    if (this.exists(info.fullname)) {
      const existing = this.getJava(info.fullname);
      if (existing && !existing.info.downloading) return existing;
      if (existing?.info.downloading) {
        throw new Error(`Java ${version} is already downloading`);
      }
    }

    info.downloading = true;
    this.addJava(info);

    try {
      const downloadUrl = await this.getJavaDownloadUrl(info);
      if (!downloadUrl) throw new Error(`No download URL for Java ${version}`);

      logger.info(`EnsureJava download: ${downloadUrl} --> ${info.fullname}`);
      const javaPath = path.join(this.javaDataDir, info.fullname);
      fs.mkdirsSync(javaPath);

      const fileName = path.basename(new URL(downloadUrl).pathname);
      const filePath = path.join(javaPath, fileName);
      await downloadManager.downloadFromUrl(downloadUrl, filePath);

      if (fileName.endsWith(".zip")) {
        const fileManager = new FileManager(javaPath, "UTF-8");
        await fileManager.unzip(fileName, ".", "UTF-8");
        const extractDir = path.join(javaPath, path.basename(fileName, ".zip"));
        if (await fs.pathExists(extractDir)) {
          const extractDirInfo = await fs.stat(extractDir);
          if (extractDirInfo.isDirectory()) {
            const files = await fs.readdir(extractDir);
            for (const file of files) {
              await fs.move(path.join(extractDir, file), path.join(javaPath, file), {
                overwrite: true
              });
            }
            await fs.remove(extractDir);
          }
        }
      } else if (fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz")) {
        await extract({
          file: filePath,
          cwd: javaPath,
          strip: 1
        });
      } else {
        throw new Error(`Unsupported Java package format: ${fileName}`);
      }

      // Prefer extracted home if nested.
      let resolvedHome = javaPath;
      if (!(await this.javaBinaryExists(resolvedHome))) {
        const entries = await fs.readdir(javaPath);
        for (const entry of entries) {
          const candidate = path.join(javaPath, entry);
          if (await this.javaBinaryExists(candidate)) {
            resolvedHome = candidate;
            break;
          }
          const nested = path.join(candidate, "Contents", "Home");
          if (await this.javaBinaryExists(nested)) {
            resolvedHome = nested;
            break;
          }
        }
      }
      if (!(await this.javaBinaryExists(resolvedHome))) {
        throw new Error(`Java binary missing after install: ${info.fullname}`);
      }

      info.downloading = false;
      info.path = resolvedHome === javaPath ? undefined : resolvedHome;
      this.updateJavaInfo(info);
      const ready = this.getJava(info.fullname);
      if (!ready) throw new Error(`Java install vanished: ${info.fullname}`);
      logger.info(`EnsureJava installed: ${info.fullname}`);
      return ready;
    } catch (error) {
      try {
        await this.removeJava(info.fullname);
      } catch {
        // ignore cleanup failure
      }
      throw error;
    }
  }

  private async registerSystemJava(version: number, javaHome: string): Promise<IJavaRuntime> {
    const idHint = `system_${version}`;
    const existing = this.getJava(idHint);
    if (existing && !existing.info.downloading) {
      const refreshed = new JavaInfo("system", existing.info.installTime, String(version));
      refreshed.fullname = idHint;
      refreshed.path = path.normalize(javaHome);
      refreshed.downloading = false;
      this.updateJavaInfo(refreshed);
      const latest = this.getJava(idHint);
      if (latest) return latest;
      return existing;
    }

    const info = new JavaInfo("system", Date.now(), String(version));
    // Force stable id system_<version>
    info.fullname = idHint;
    info.path = path.normalize(javaHome);
    info.downloading = false;
    this.addJava(info);
    const runtime = this.getJava(info.fullname);
    if (!runtime) throw new Error(`Failed to register system Java ${version}`);
    return runtime;
  }

  public async ensureJava(versionInput: number | string): Promise<EnsureJavaResult> {
    const version = Number(versionInput);
    if (!Number.isFinite(version) || version < 8) {
      throw new Error(`Invalid Java version: ${String(versionInput)}`);
    }

    const mem = this.hostMemorySnapshot();
    let source: EnsureJavaSource = "managed";
    let runtime = this.findManagedJava(version);

    if (!runtime) {
      const systemHome = await this.detectSystemJavaHome(version);
      if (systemHome) {
        runtime = await this.registerSystemJava(version, systemHome);
        source = "system";
      }
    }

    if (!runtime) {
      runtime = await this.installManagedJava(version);
      source = "downloaded";
    }

    // Wait briefly if another download marked downloading.
    for (let i = 0; i < 120 && runtime.info.downloading; i++) {
      await sleep(1000);
      const latest = this.getJava(runtime.info.fullname);
      if (!latest) throw new Error(`Java runtime disappeared while downloading: ${version}`);
      runtime = latest;
    }
    if (runtime.info.downloading) {
      throw new Error(`Timed out waiting for Java ${version} download`);
    }

    const command = await this.getJavaRuntimeCommand(runtime.info.fullname);
    // Soft verify binary can print version.
    try {
      const bare = command.replace(/^"(.*)"$/, "$1");
      await execFileAsync(bare, ["-version"], { timeout: 8000 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Java ${version} runtime check failed: ${msg}`);
    }

    return {
      id: runtime.info.fullname,
      version,
      source,
      command,
      hostMemoryMb: mem.hostMemoryMb,
      hostFreeMemoryMb: mem.hostFreeMemoryMb
    };
  }

  async getJavaRuntimeCommand(id: string) {
    const java = this.getJava(id);
    if (!java) throw new Error($t("TXT_CODE_77ce8542"));
    if (java.info.downloading) throw new Error($t("TXT_CODE_45d02bb7"));

    let javaPath = java.info.path ?? java.path;
    if (!javaPath) throw new Error($t("TXT_CODE_82c8bca3"));

    // For macOS, if Java is within a .jdk bundle, use the Contents/Home/bin/java path
    if (os.platform() === "darwin") {
      // Scan first-level subdirectories under javaPath to find Contents directory
      try {
        const entries = await fs.readdir(javaPath);
        for (const entry of entries) {
          const entryPath = path.join(javaPath, entry);
          const stat = await fs.stat(entryPath);
          if (stat.isDirectory()) {
            const contentsPath = path.join(entryPath, "Contents");
            if (await fs.pathExists(contentsPath)) {
              // Found Contents directory, construct new javaPath
              javaPath = path.join(entryPath, "Contents", "Home");
              break;
            }
          }
        }
      } catch (error) {
        // If scan fails, use original javaPath
      }
    }

    const javaRuntimePath = path.join(
      javaPath,
      "bin",
      os.platform() == "win32" ? "java.exe" : "java"
    );

    return `"${javaRuntimePath}"`;
  }

  async removeJava(id: string) {
    const java = this.getJava(id);
    if (!java) throw new Error($t("TXT_CODE_77ce8542"));

    // if (java.info.downloading) throw new Error($t("TXT_CODE_887fee99"));
    if (java.usingInstances.length) throw new Error($t("TXT_CODE_ea8ea5d1"));

    let javaPath = java.path;
    if (!javaPath) throw new Error($t("TXT_CODE_82c8bca3"));

    await fs.remove(javaPath);
    this.javaList.delete(id);

    return true;
  }
}

const javaManager = new JavaManager();

InstanceSubsystem.on("open", (obj: { instanceUuid: string }) => {
  const instanceUuid = obj.instanceUuid;
  const config = InstanceSubsystem.getInstance(instanceUuid)?.config;
  if (!config) return;

  const javaId = config.java.id;
  if (!javaId) return;

  const java = javaManager.getJava(javaId);
  if (java && !java.usingInstances.includes(instanceUuid)) java.usingInstances.push(instanceUuid);
});

const handleStopInstance = (obj: { instanceUuid: string }) => {
  const instanceUuid = obj.instanceUuid;
  const config = InstanceSubsystem.getInstance(instanceUuid)?.config;
  if (!config) return;

  const javaId = config.java.id;
  if (!javaId) return;

  const java = javaManager.getJava(javaId);
  if (java && !java.usingInstances.includes(instanceUuid))
    java.usingInstances.filter((uuid) => uuid !== instanceUuid);
};

InstanceSubsystem.on("exit", handleStopInstance);
InstanceSubsystem.on("failure", handleStopInstance);

export default javaManager;
