import axios from "axios";

const UA = "MCSManager-Pro-PreciseInstaller/1.0";

type LoaderId = "vanilla" | "fabric" | "forge" | "neoforge" | "paper";

export interface McLoaderInfo {
  id: LoaderId;
  name: string;
  description: string;
  supportsBuildSelect: boolean;
}

export interface McVersionItem {
  id: string;
  type?: string;
  releaseTime?: string;
  stable?: boolean;
  recommendedJava?: number;
}

export interface McBuildItem {
  id: string;
  label: string;
  stable?: boolean;
  time?: string;
  raw?: Record<string, unknown>;
}

export interface McInstallPlan {
  loader: LoaderId;
  mcVersion: string;
  buildId?: string;
  title: string;
  targetLink: string;
  recommendedJava: number;
  setupInfo: Partial<IGlobalInstanceConfig>;
  memory?: {
    xms: string;
    xmx: string;
    xmsMb: number;
    xmxMb: number;
  };
}

export interface EnsureJavaResult {
  id: string;
  version: number;
  source: "managed" | "system" | "downloaded";
  command: string;
  hostMemoryMb: number;
  hostFreeMemoryMb: number;
}

export interface AdaptiveMemory {
  xms: string;
  xmx: string;
  xmsMb: number;
  xmxMb: number;
  hostMemoryMb: number;
  preferredXmxMb: number;
  reduced: boolean;
}

export type LoaderIdPublic = LoaderId;


const cache = new Map<string, { exp: number; data: unknown }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return undefined;
  }
  return hit.data as T;
}

function cacheSet(key: string, data: unknown, ttlMs: number) {
  cache.set(key, { exp: Date.now() + ttlMs, data });
}

async function httpGetJson<T>(url: string, ttlMs = 10 * 60_000): Promise<T> {
  const key = `GET:${url}`;
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;
  const res = await axios.get(url, {
    timeout: 20_000,
    headers: { "User-Agent": UA, Accept: "application/json" },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400
  });
  cacheSet(key, res.data, ttlMs);
  return res.data as T;
}

/**
 * Last-resort guess when Mojang metadata is unreachable.
 * Never use this for the real install path if official metadata is available.
 */
function guessJavaFallback(mcVersion: string, fallback = 17): number {
  const v = String(mcVersion || "").trim();
  if (/^1\.16(\.|$)/.test(v) || /^1\.1[0-5](\.|$)/.test(v)) return 8;
  if (/^1\.17(\.|$)/.test(v)) return 16;
  if (/^1\.1[89](\.|$)/.test(v) || /^1\.20(\.|$)/.test(v)) return 17;
  if (/^1\.21(\.|$)/.test(v)) return 21;
  // Calendar versions (26.x+) currently track Java 25; only a fallback.
  if (/^\d{2}(\.|$)/.test(v)) return 25;
  return fallback;
}

/** In-memory cache: mcVersion -> official major Java version from Mojang. */
const officialJavaCache = new Map<string, number>();

type MojangVersionManifest = {
  versions: Array<{ id: string; url: string; type?: string; releaseTime?: string }>;
};

type MojangVersionMeta = {
  downloads?: { server?: { url?: string } };
  javaVersion?: { majorVersion?: number; component?: string };
  java_version?: number;
};

async function getMojangVersionManifest(): Promise<MojangVersionManifest> {
  return httpGetJson<MojangVersionManifest>(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    30 * 60_000
  );
}

/**
 * Source of truth for required Java major version:
 * Mojang version JSON `javaVersion.majorVersion`.
 * Cached per mcVersion so list/plan/install stay consistent.
 */
export async function resolveRecommendedJava(
  mcVersion: string,
  fallback = 17
): Promise<number> {
  const id = String(mcVersion || "").trim();
  if (!id) return fallback;
  const cached = officialJavaCache.get(id);
  if (cached != null) return cached;

  try {
    const manifest = await getMojangVersionManifest();
    const item = (manifest.versions || []).find((v) => v.id === id);
    if (!item?.url) {
      return guessJavaFallback(id, fallback);
    }
    const meta = await httpGetJson<MojangVersionMeta>(item.url, 30 * 60_000);
    const major =
      Number(meta.javaVersion?.majorVersion) ||
      Number(meta.java_version) ||
      0;
    if (Number.isFinite(major) && major >= 8) {
      officialJavaCache.set(id, major);
      return major;
    }
  } catch {
    // fall through to guess
  }
  return guessJavaFallback(id, fallback);
}

/** Sync peek for list UI: official cache if warm, otherwise guess. */
function peekRecommendedJava(mcVersion: string, fallback = 17): number {
  const id = String(mcVersion || "").trim();
  return officialJavaCache.get(id) ?? guessJavaFallback(id, fallback);
}

/** Best-effort warm official Java majors for a version list (non-blocking for callers that await it). */
async function warmOfficialJava(ids: string[], limit = 30): Promise<void> {
  const targets = ids.slice(0, limit);
  await Promise.all(
    targets.map(async (id) => {
      try {
        await resolveRecommendedJava(id);
      } catch {
        // ignore individual failures
      }
    })
  );
}


function preferredMemMb(loader: LoaderId): { xmsMb: number; xmxMb: number } {
  if (loader === "forge" || loader === "neoforge") return { xmsMb: 4096, xmxMb: 8192 };
  if (loader === "fabric") return { xmsMb: 2048, xmxMb: 4096 };
  return { xmsMb: 2048, xmxMb: 2048 };
}

function formatMem(mb: number): string {
  return `${Math.max(256, Math.floor(mb))}M`;
}

/** Adapt heap to host memory so 8G machines don't get Xmx4G by default. */
export function adaptiveMemory(
  loader: LoaderId,
  hostMemoryMb: number,
  hostFreeMemoryMb?: number
): AdaptiveMemory {
  const preferred = preferredMemMb(loader);
  const host = Number.isFinite(hostMemoryMb) && hostMemoryMb > 0 ? hostMemoryMb : 8192;
  // Keep headroom for OS + panel/daemon + other services.
  const reserveMb = Math.max(1536, Math.floor(host * 0.35));
  const free = Number.isFinite(hostFreeMemoryMb || NaN)
    ? Math.max(0, Number(hostFreeMemoryMb))
    : host - reserveMb;
  const hardCap = Math.max(1024, host - reserveMb);
  const softCap = Math.max(1024, Math.min(hardCap, free > 0 ? free : hardCap));
  let xmxMb = Math.min(preferred.xmxMb, softCap, hardCap);
  // Never give more than ~45% of host on small machines.
  xmxMb = Math.min(xmxMb, Math.floor(host * 0.45));
  xmxMb = Math.max(1024, Math.floor(xmxMb));
  let xmsMb = Math.min(preferred.xmsMb, Math.floor(xmxMb * 0.5));
  xmsMb = Math.max(512, Math.floor(xmsMb));
  if (xmsMb > xmxMb) xmsMb = xmxMb;
  return {
    xms: formatMem(xmsMb),
    xmx: formatMem(xmxMb),
    xmsMb,
    xmxMb,
    hostMemoryMb: host,
    preferredXmxMb: preferred.xmxMb,
    reduced: xmxMb < preferred.xmxMb
  };
}

function memByLoader(loader: LoaderId): { xms: string; xmx: string } {
  // Fallback static defaults when host memory is unknown.
  const preferred = preferredMemMb(loader);
  return { xms: formatMem(preferred.xmsMb), xmx: formatMem(preferred.xmxMb) };
}

function withManagedJavaCommand(
  command: string,
  mem: { xms: string; xmx: string }
): string {
  // Force managed java placeholder; keep remaining args.
  const trimmed = command.trim();
  if (!trimmed) {
    return `{mcsm_java} -Xms${mem.xms} -Xmx${mem.xmx} -jar server.jar nogui`;
  }
  // Scripts (run.sh) keep as-is; installer may still need java for updateCommand.
  if (trimmed.startsWith("sh ") || trimmed.startsWith("bash ") || trimmed.includes("./run.sh")) {
    return trimmed;
  }
  // Replace leading java token with placeholder and normalize memory flags if present.
  const parts = trimmed.split(/\s+/);
  if (parts[0] === "java" || parts[0] === "{mcsm_java}") {
    parts[0] = "{mcsm_java}";
  } else {
    parts.unshift("{mcsm_java}");
  }
  // Ensure -Xms/-Xmx exist / refresh them.
  const withoutMem = parts.filter((p) => !p.startsWith("-Xms") && !p.startsWith("-Xmx"));
  // Insert memory flags after java binary.
  const head = withoutMem[0];
  const rest = withoutMem.slice(1);
  return [head, `-Xms${mem.xms}`, `-Xmx${mem.xmx}`, ...rest].join(" ");
}

export function applyRuntimeToPlan(
  plan: McInstallPlan,
  opts: {
    javaId?: string;
    memory?: AdaptiveMemory;
  }
): McInstallPlan {
  const mem = opts.memory || {
    ...memByLoader(plan.loader),
    xmsMb: 0,
    xmxMb: 0,
    hostMemoryMb: 0,
    preferredXmxMb: 0,
    reduced: false
  };
  const setupInfo: Partial<IGlobalInstanceConfig> = {
    ...plan.setupInfo
  };
  if (setupInfo.startCommand) {
    setupInfo.startCommand = withManagedJavaCommand(setupInfo.startCommand, mem);
  }
  if (setupInfo.updateCommand && opts.javaId) {
    // Use managed java for installer/update as well.
    const uc = setupInfo.updateCommand.trim();
    if (uc.startsWith("java ")) {
      setupInfo.updateCommand = `{mcsm_java}${uc.slice("java".length)}`;
    }
  }
  if (opts.javaId) {
    setupInfo.java = { id: opts.javaId };
  }
  return {
    ...plan,
    setupInfo,
    memory: {
      xms: mem.xms,
      xmx: mem.xmx,
      xmsMb: mem.xmsMb,
      xmxMb: mem.xmxMb
    }
  };
}

export function listLoaders(): McLoaderInfo[] {
  return [
    {
      id: "vanilla",
      name: "Vanilla",
      description: "Official Mojang server jar",
      supportsBuildSelect: false
    },
    {
      id: "fabric",
      name: "Fabric",
      description: "Lightweight mod loader (real-time from Fabric Meta)",
      supportsBuildSelect: true
    },
    {
      id: "forge",
      name: "Forge",
      description: "Classic mod loader (via BMCLAPI index)",
      supportsBuildSelect: true
    },
    {
      id: "neoforge",
      name: "NeoForge",
      description: "Modern Forge fork (via BMCLAPI index)",
      supportsBuildSelect: true
    },
    {
      id: "paper",
      name: "Paper",
      description: "High-performance plugin server (Paper Fill API)",
      supportsBuildSelect: true
    }
  ];
}

async function listVanillaVersions(): Promise<McVersionItem[]> {
  const manifest = await getMojangVersionManifest();
  return (manifest.versions || [])
    .filter((v) => v.type === "release")
    .map((v) => ({
      id: v.id,
      type: v.type,
      releaseTime: v.releaseTime,
      stable: true,
      recommendedJava: peekRecommendedJava(v.id)
    }));
}

async function listFabricVersions(): Promise<McVersionItem[]> {
  const games = await httpGetJson<Array<{ version: string; stable: boolean }>>(
    "https://meta.fabricmc.net/v2/versions/game",
    15 * 60_000
  );
  const stable = games.filter((g) => g.stable).map((g) => g.version);
  const unstable = games.filter((g) => !g.stable).map((g) => g.version);
  return [...stable, ...unstable].map((id) => ({
    id,
    stable: stable.includes(id),
    recommendedJava: peekRecommendedJava(id)
  }));
}

async function listForgeMcVersions(): Promise<McVersionItem[]> {
  const vanilla = await listVanillaVersions();
  return vanilla.map((v) => ({
    ...v,
    recommendedJava: peekRecommendedJava(v.id, 17)
  }));
}

async function listNeoForgeMcVersions(): Promise<McVersionItem[]> {
  const vanilla = await listVanillaVersions();
  return vanilla
    .filter((v) => {
      if (v.id.startsWith("1.20.1")) return false;
      if (v.id.startsWith("1.20.")) return true;
      if (v.id.startsWith("1.21")) return true;
      if (/^\d{2}\./.test(v.id)) return true;
      return false;
    })
    .map((v) => ({
      ...v,
      recommendedJava: peekRecommendedJava(v.id, 21)
    }));
}

async function listPaperVersions(): Promise<McVersionItem[]> {
  const data = await httpGetJson<{
    versions: Record<string, string[]>;
  }>("https://fill.papermc.io/v3/projects/paper", 15 * 60_000);
  const ids: string[] = [];
  for (const arr of Object.values(data.versions || {})) {
    for (const v of arr || []) ids.push(v);
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered.map((id) => ({
    id,
    stable: true,
    recommendedJava: peekRecommendedJava(id, 21)
  }));
}

export async function listVersions(loader: LoaderId): Promise<McVersionItem[]> {
  let versions: McVersionItem[];
  switch (loader) {
    case "vanilla":
      versions = await listVanillaVersions();
      break;
    case "fabric":
      versions = await listFabricVersions();
      break;
    case "forge":
      versions = await listForgeMcVersions();
      break;
    case "neoforge":
      versions = await listNeoForgeMcVersions();
      break;
    case "paper":
      versions = await listPaperVersions();
      break;
    default:
      throw new Error(`Unsupported loader: ${loader}`);
  }
  // Warm official Java majors for the newest releases so UI badges are accurate.
  // Failures fall back to guess; install path always re-resolves via Mojang.
  try {
    await warmOfficialJava(versions.map((v) => v.id), 40);
    versions = versions.map((v) => ({
      ...v,
      recommendedJava: peekRecommendedJava(v.id, v.recommendedJava || 17)
    }));
  } catch {
    // keep guessed values
  }
  return versions;
}

export async function listBuilds(loader: LoaderId, mcVersion: string): Promise<McBuildItem[]> {
  if (loader === "vanilla") {
    return [{ id: "official", label: "Official server.jar", stable: true }];
  }

  if (loader === "fabric") {
    const loaders = await httpGetJson<
      Array<{
        loader: { version: string; stable: boolean };
      }>
    >(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, 10 * 60_000);
    return (loaders || []).slice(0, 80).map((x) => ({
      id: x.loader.version,
      label: `Fabric Loader ${x.loader.version}${x.loader.stable ? " (stable)" : ""}`,
      stable: !!x.loader.stable
    }));
  }

  if (loader === "forge") {
    const list = await httpGetJson<
      Array<{ version: string; build: number; modified?: string; mcversion?: string }>
    >(
      `https://bmclapi2.bangbang93.com/forge/minecraft/${encodeURIComponent(mcVersion)}`,
      10 * 60_000
    );
    const sorted = [...(list || [])].sort((a, b) => (b.build || 0) - (a.build || 0));
    return sorted.slice(0, 100).map((x, idx) => ({
      id: x.version,
      label: `Forge ${x.version}${idx === 0 ? " (latest)" : ""}`,
      stable: idx === 0,
      time: x.modified
    }));
  }

  if (loader === "neoforge") {
    const list = await httpGetJson<
      Array<{ rawVersion?: string; version?: string; mcversion?: string }>
    >(
      `https://bmclapi2.bangbang93.com/neoforge/list/${encodeURIComponent(mcVersion)}`,
      10 * 60_000
    );
    const rows = (list || [])
      .map((x) => {
        const raw = String(x.rawVersion || x.version || "");
        const id = raw.replace(/^neoforge-/, "");
        return { id, raw };
      })
      .filter((x) => x.id);
    rows.reverse();
    return rows.slice(0, 100).map((x, idx) => ({
      id: x.id,
      label: `NeoForge ${x.id}${idx === 0 ? " (latest)" : ""}`,
      stable: idx === 0
    }));
  }

  if (loader === "paper") {
    const builds = await httpGetJson<
      Array<{
        id: number;
        channel?: string;
        time?: string;
        downloads?: Record<string, { name?: string; url?: string }>;
      }>
    >(
      `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`,
      10 * 60_000
    );
    const sorted = [...(builds || [])].sort((a, b) => (b.id || 0) - (a.id || 0));
    return sorted.slice(0, 50).map((b, idx) => ({
      id: String(b.id),
      label: `Build ${b.id}${b.channel ? ` · ${b.channel}` : ""}${idx === 0 ? " (latest)" : ""}`,
      stable: String(b.channel || "").toUpperCase() === "STABLE" || idx === 0,
      time: b.time,
      raw: b as unknown as Record<string, unknown>
    }));
  }

  return [];
}

async function resolveVanillaServer(mcVersion: string): Promise<{
  url: string;
  java: number;
  jarName: string;
}> {
  const manifest = await getMojangVersionManifest();
  const item = (manifest.versions || []).find((v) => v.id === mcVersion);
  if (!item) throw new Error(`Vanilla version not found: ${mcVersion}`);
  const meta = await httpGetJson<MojangVersionMeta>(item.url, 30 * 60_000);
  const url = meta.downloads?.server?.url;
  if (!url) throw new Error(`No official server jar for ${mcVersion}`);
  const major =
    Number(meta.javaVersion?.majorVersion) ||
    Number(meta.java_version) ||
    0;
  if (Number.isFinite(major) && major >= 8) {
    officialJavaCache.set(mcVersion, major);
  }
  return {
    url,
    java: major >= 8 ? major : await resolveRecommendedJava(mcVersion),
    jarName: "server.jar"
  };
}

async function resolveFabricInstaller(): Promise<{ url: string; version: string; fileName: string }> {
  const list = await httpGetJson<Array<{ url: string; version: string; stable?: boolean }>>(
    "https://meta.fabricmc.net/v2/versions/installer",
    30 * 60_000
  );
  const selected = list.find((x) => x.stable) || list[0];
  if (!selected?.url) throw new Error("Fabric installer not found");
  const fileName = selected.url.split("/").pop() || `fabric-installer-${selected.version}.jar`;
  return { url: selected.url, version: selected.version, fileName };
}

function dockerImageForJava(java: number): string {
  // Prefer exact major Temurin tags; fall back to nearest supported LTS channel.
  if (java >= 25) return `eclipse-temurin:${java}-jdk`;
  if (java >= 21) return "eclipse-temurin:21-jdk";
  if (java >= 17) return "eclipse-temurin:17-jdk";
  if (java >= 11) return "eclipse-temurin:11-jdk";
  return "eclipse-temurin:8-jdk";
}

export async function buildInstallPlan(input: {
  loader: LoaderId;
  mcVersion: string;
  buildId?: string;
}): Promise<McInstallPlan> {
  const loader = input.loader;
  const mcVersion = String(input.mcVersion || "").trim();
  if (!mcVersion) throw new Error("mcVersion required");
  const mem = memByLoader(loader);

  if (loader === "vanilla") {
    const server = await resolveVanillaServer(mcVersion);
    return {
      loader,
      mcVersion,
      buildId: "official",
      title: `[Vanilla] Minecraft ${mcVersion}`,
      targetLink: server.url,
      recommendedJava: server.java,
      setupInfo: {
        type: "minecraft/java",
        startCommand: `java -Xms${mem.xms} -Xmx${mem.xmx} -jar ${server.jarName} nogui`,
        stopCommand: "stop",
        updateCommand: "",
        ie: "utf-8",
        oe: "utf-8",
        processType: "general",
        tag: ["Minecraft", "Vanilla", mcVersion]
      }
    };
  }

  if (loader === "fabric") {
    const builds = await listBuilds("fabric", mcVersion);
    if (!builds.length) throw new Error(`No Fabric loader for ${mcVersion}`);
    const preferred =
      builds.find((b) => b.id === input.buildId) ||
      builds.find((b) => b.stable) ||
      builds[0];
    const installer = await resolveFabricInstaller();
    const java = await resolveRecommendedJava(mcVersion, 17);
    return {
      loader,
      mcVersion,
      buildId: preferred.id,
      title: `[Fabric] Minecraft ${mcVersion} / Loader ${preferred.id}`,
      targetLink: installer.url,
      recommendedJava: java,
      setupInfo: {
        type: "minecraft/java/fabric",
        startCommand: `java -Xms${mem.xms} -Xmx${mem.xmx} -jar fabric-server-launch.jar nogui`,
        stopCommand: "stop",
        updateCommand: `java -jar ${installer.fileName} server -mcversion ${mcVersion} -loader ${preferred.id} -downloadMinecraft -noprofile`,
        ie: "utf-8",
        oe: "utf-8",
        processType: "general",
        tag: ["Minecraft", "Fabric", mcVersion, preferred.id]
      }
    };
  }

  if (loader === "forge") {
    const builds = await listBuilds("forge", mcVersion);
    if (!builds.length) throw new Error(`No Forge builds for ${mcVersion}`);
    const preferred =
      builds.find((b) => b.id === input.buildId) || builds.find((b) => b.stable) || builds[0];
    const targetLink = `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${encodeURIComponent(
      `${mcVersion}-${preferred.id}`
    )}/forge-${encodeURIComponent(mcVersion)}-${encodeURIComponent(preferred.id)}-installer.jar`;
    const java = await resolveRecommendedJava(mcVersion, 17);
    return {
      loader,
      mcVersion,
      buildId: preferred.id,
      title: `[Forge] Minecraft ${mcVersion} / ${preferred.id}`,
      targetLink,
      recommendedJava: java,
      setupInfo: {
        type: "minecraft/java/forge",
        startCommand: "sh ./run.sh",
        stopCommand: "stop",
        updateCommand: `java -jar forge-${mcVersion}-${preferred.id}-installer.jar --installServer`,
        ie: "utf-8",
        oe: "utf-8",
        processType: "general",
        tag: ["Minecraft", "Forge", mcVersion, preferred.id]
      }
    };
  }

  if (loader === "neoforge") {
    const builds = await listBuilds("neoforge", mcVersion);
    if (!builds.length) throw new Error(`No NeoForge builds for ${mcVersion}`);
    const preferred =
      builds.find((b) => b.id === input.buildId) || builds.find((b) => b.stable) || builds[0];
    const targetLink = `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${encodeURIComponent(
      preferred.id
    )}/neoforge-${encodeURIComponent(preferred.id)}-installer.jar`;
    const java = await resolveRecommendedJava(mcVersion, 21);
    return {
      loader,
      mcVersion,
      buildId: preferred.id,
      title: `[NeoForge] Minecraft ${mcVersion} / ${preferred.id}`,
      targetLink,
      recommendedJava: java,
      setupInfo: {
        type: "minecraft/java/neoforge",
        startCommand: "sh ./run.sh",
        stopCommand: "stop",
        updateCommand: `java -jar neoforge-${preferred.id}-installer.jar --installServer`,
        ie: "utf-8",
        oe: "utf-8",
        processType: "general",
        tag: ["Minecraft", "NeoForge", mcVersion, preferred.id]
      }
    };
  }

  if (loader === "paper") {
    const builds = await listBuilds("paper", mcVersion);
    if (!builds.length) throw new Error(`No Paper builds for ${mcVersion}`);
    const preferred =
      builds.find((b) => b.id === input.buildId) || builds.find((b) => b.stable) || builds[0];
    const rawBuilds = await httpGetJson<
      Array<{
        id: number;
        downloads?: Record<string, { name?: string; url?: string }>;
      }>
    >(
      `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`,
      10 * 60_000
    );
    const row = (rawBuilds || []).find((b) => String(b.id) === preferred.id);
    const dl =
      row?.downloads?.["server:default"] ||
      row?.downloads?.["server"] ||
      Object.values(row?.downloads || {})[0];
    if (!dl?.url) throw new Error(`Paper download missing for ${mcVersion} build ${preferred.id}`);
    const jarName = dl.name || `paper-${mcVersion}-${preferred.id}.jar`;
    const java = await resolveRecommendedJava(mcVersion, 21);
    return {
      loader,
      mcVersion,
      buildId: preferred.id,
      title: `[Paper] Minecraft ${mcVersion} / build ${preferred.id}`,
      targetLink: dl.url,
      recommendedJava: java,
      setupInfo: {
        type: "minecraft/java/paper",
        startCommand: `java -Xms${mem.xms} -Xmx${mem.xmx} -jar ${jarName} nogui`,
        stopCommand: "stop",
        updateCommand: "",
        ie: "utf-8",
        oe: "utf-8",
        processType: "general",
        tag: ["Minecraft", "Paper", mcVersion, preferred.id]
      }
    };
  }

  throw new Error(`Unsupported loader: ${loader}`);
}

export interface DockerHint {
  image: string;
  updateCommandImage: string;
  workingDir: string;
  changeWorkdir: boolean;
  ports: string[];
  env: string[];
  extraVolumes: string[];
}

export function dockerHint(java: number): DockerHint {
  return {
    image: dockerImageForJava(java),
    updateCommandImage: dockerImageForJava(java),
    workingDir: "/data",
    changeWorkdir: true,
    ports: ["{mcsm_port1}:25565/tcp"],
    env: [],
    extraVolumes: []
  };
}
