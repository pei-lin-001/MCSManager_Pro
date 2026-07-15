import Router from "@koa/router";
import { PassThrough } from "stream";
import os from "os";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import RemoteServiceSubsystem from "../service/remote_service";
import RemoteRequest from "../service/remote_command";
import {
  adaptiveMemory,
  applyRuntimeToPlan,
  buildInstallPlan,
  dockerHint,
  listBuilds,
  listLoaders,
  listVersions,
  type AdaptiveMemory,
  type DockerHint,
  type EnsureJavaResult,
  type LoaderIdPublic,
  type McInstallPlan
} from "../service/mc_precise_service";

const router = new Router({ prefix: "/mc_precise" });

const LOADERS: Record<LoaderIdPublic, true> = {
  vanilla: true,
  fabric: true,
  forge: true,
  neoforge: true,
  paper: true
};

function isLoaderId(value: string): value is LoaderIdPublic {
  return Object.prototype.hasOwnProperty.call(LOADERS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface InstallTaskResult {
  instanceUuid?: string;
  taskId?: string;
  status?: number;
}

interface InstallProgressStep {
  id: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  message: string;
}

interface TrialStartResult {
  ok: boolean;
  status: number;
  message: string;
  logTail?: string;
}

type PreciseInstallEvent =
  | { type: "step"; steps: InstallProgressStep[] }
  | {
      type: "result";
      ok: boolean;
      plan?: McInstallPlan & { dockerOptional?: DockerHint };
      task?: InstallTaskResult;
      java?: EnsureJavaResult | null;
      memory?: AdaptiveMemory;
      steps: InstallProgressStep[];
      trial?: TrialStartResult;
      instanceUuid?: string;
      error?: string;
    }
  | { type: "error"; message: string };

function createInstallSseStream(): {
  stream: PassThrough;
  writeEvent: (event: PreciseInstallEvent) => void;
  end: () => void;
} {
  const stream = new PassThrough();
  const writeEvent = (event: PreciseInstallEvent) => {
    stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const end = () => {
    stream.write("data: [DONE]\n\n");
    stream.end();
  };
  return { stream, writeEvent, end };
}

function markStep(
  steps: InstallProgressStep[],
  id: string,
  status: InstallProgressStep["status"],
  message?: string
): void {
  const step = steps.find((s) => s.id === id);
  if (!step) return;
  step.status = status;
  if (message) step.message = message;
}

async function sleep(ms: number): Promise<void> {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  setTimeout(resolve, ms);
  return promise;
}

async function waitForInstallTask(
  remote: RemoteRequest,
  task: InstallTaskResult,
  timeoutMs = 12 * 60_000
): Promise<{ ok: boolean; status: number; detail?: Record<string, unknown> }> {
  const taskId = task.taskId;
  const instanceUuid = task.instanceUuid;
  if (!taskId) return { ok: false, status: -1 };

  const started = Date.now();
  let lastStatus = 1;
  while (Date.now() - started < timeoutMs) {
    try {
      const detailUnknown = await remote.request<unknown>(
        "instance/query_asynchronous",
        {
          instanceUuid,
          taskName: "quick_install",
          parameter: { taskId }
        },
        15_000
      );
      const detail = isRecord(detailUnknown) ? detailUnknown : {};
      const nested = isRecord(detail.detail) ? detail.detail : undefined;
      const status =
        typeof detail.status === "number" && Number.isFinite(detail.status)
          ? detail.status
          : typeof nested?.status === "number" && Number.isFinite(nested.status)
            ? nested.status
            : lastStatus;
      lastStatus = status;
      if (status === 0) return { ok: true, status, detail };
      if (status === -1) return { ok: false, status, detail };
    } catch {
      if (instanceUuid) {
        try {
          await remote.request("instance/detail", { instanceUuid }, 10_000);
          return { ok: true, status: 0 };
        } catch {
          // keep waiting
        }
      }
    }
    await sleep(2000);
  }
  return { ok: false, status: lastStatus };
}

async function writeEula(remote: RemoteRequest, instanceUuid: string): Promise<void> {
  // file/edit requires the file to already exist; create first.
  try {
    await remote.request("file/touch", { instanceUuid, target: "eula.txt" }, 15_000);
  } catch {
    // may already exist
  }
  await remote.request(
    "file/edit",
    {
      instanceUuid,
      target: "eula.txt",
      text: "#Accepted by MCSManager precise installer\neula=true\n"
    },
    15_000
  );
}

async function readLogTail(remote: RemoteRequest, instanceUuid: string): Promise<string> {
  try {
    const rawLog = await remote.request<unknown>(
      "instance/outputlog",
      { instanceUuid },
      10_000
    );
    const full = typeof rawLog === "string" ? rawLog : String(rawLog ?? "");
    return full
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-80)
      .join("\n");
  } catch {
    return "";
  }
}

async function trialStart(
  remote: RemoteRequest,
  instanceUuid: string,
  timeoutMs = 120_000
): Promise<TrialStartResult> {
  await writeEula(remote, instanceUuid);
  await remote.request("instance/open", { instanceUuids: [instanceUuid] }, 20_000);

  const started = Date.now();
  let lastStatus = 0;
  let sawStarting = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(2500);
    const detailUnknown = await remote.request<unknown>(
      "instance/detail",
      { instanceUuid },
      10_000
    );
    const detail = isRecord(detailUnknown) ? detailUnknown : {};
    lastStatus =
      typeof detail.status === "number" && Number.isFinite(detail.status) ? detail.status : 0;
    if (lastStatus === 2 || lastStatus === -1) {
      sawStarting = true;
    }
    if (lastStatus === 3) {
      // Confirm not immediately dying on EULA by checking recent logs.
      const logTail = await readLogTail(remote, instanceUuid);
      if (/You need to agree to the EULA/i.test(logTail) || /eula=false/i.test(logTail)) {
        // rewrite and restart once
        await writeEula(remote, instanceUuid);
        await remote.request("instance/restart", { instanceUuids: [instanceUuid] }, 20_000);
        continue;
      }
      return {
        ok: true,
        status: lastStatus,
        message: "Instance started successfully",
        logTail: logTail || undefined
      };
    }
    if (lastStatus === 0 && sawStarting) {
      break;
    }
  }

  const logTail = await readLogTail(remote, instanceUuid);
  let message = `Trial start did not reach RUNNING (status=${lastStatus})`;
  if (/UnsupportedClassVersionError|class file version/i.test(logTail)) {
    message =
      "Trial start failed: Java version too old for this Minecraft version (UnsupportedClassVersionError)";
  } else if (/You need to agree to the EULA|eula/i.test(logTail)) {
    // One recovery attempt already may have happened; try hard fix.
    try {
      await writeEula(remote, instanceUuid);
      await remote.request("instance/open", { instanceUuids: [instanceUuid] }, 20_000);
      await sleep(8000);
      const detailUnknown = await remote.request<unknown>(
        "instance/detail",
        { instanceUuid },
        10_000
      );
      const detail = isRecord(detailUnknown) ? detailUnknown : {};
      const status =
        typeof detail.status === "number" && Number.isFinite(detail.status) ? detail.status : 0;
      if (status === 3) {
        return {
          ok: true,
          status,
          message: "Instance started after EULA fix",
          logTail: (await readLogTail(remote, instanceUuid)) || undefined
        };
      }
    } catch {
      // fall through
    }
    message = "Trial start failed: EULA not accepted";
  } else if (logTail) {
    message = "Trial start failed; see logTail for details";
  }

  return {
    ok: false,
    status: lastStatus,
    message,
    logTail: logTail || undefined
  };
}

router.get("/loaders", permission({ level: ROLE.MANAGER }), async (ctx) => {
  ctx.body = listLoaders();
});

router.get(
  "/versions",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { loader: String } }),
  async (ctx) => {
    const loader = String(ctx.query.loader || "").toLowerCase();
    if (!isLoaderId(loader)) throw new Error(`Unsupported loader: ${loader}`);
    ctx.body = await listVersions(loader);
  }
);

router.get(
  "/builds",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { loader: String, mcVersion: String } }),
  async (ctx) => {
    const loader = String(ctx.query.loader || "").toLowerCase();
    const mcVersion = String(ctx.query.mcVersion || "");
    if (!isLoaderId(loader)) throw new Error(`Unsupported loader: ${loader}`);
    ctx.body = await listBuilds(loader, mcVersion);
  }
);

router.post(
  "/plan",
  permission({ level: ROLE.MANAGER }),
  validator({
    body: {
      loader: String,
      mcVersion: String
    }
  }),
  async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      loader?: string;
      mcVersion?: string;
      buildId?: string;
    };
    const loader = String(body.loader || "").toLowerCase();
    if (!isLoaderId(loader)) throw new Error(`Unsupported loader: ${loader}`);
    const plan = await buildInstallPlan({
      loader,
      mcVersion: String(body.mcVersion || ""),
      buildId: body.buildId ? String(body.buildId) : undefined
    });
    const hostMb = Math.floor(os.totalmem() / 1024 / 1024);
    const freeMb = Math.floor(os.freemem() / 1024 / 1024);
    const mem = adaptiveMemory(loader, hostMb, freeMb);
    const runtimePlan = applyRuntimeToPlan(plan, { memory: mem });
    ctx.body = {
      ...runtimePlan,
      dockerOptional: dockerHint(plan.recommendedJava),
      memoryHint: mem
    };
  }
);

interface PreciseInstallInput {
  daemonId: string;
  loader: LoaderIdPublic;
  mcVersion: string;
  buildId?: string;
  newInstanceName: string;
  useDocker: boolean;
  autoStart: boolean;
  waitForInstall: boolean;
}

interface PreciseInstallResult {
  ok: boolean;
  plan: McInstallPlan & { dockerOptional?: DockerHint };
  task?: InstallTaskResult;
  java?: EnsureJavaResult | null;
  memory?: AdaptiveMemory;
  steps: InstallProgressStep[];
  trial?: TrialStartResult;
  instanceUuid?: string;
  error?: string;
}

async function runPreciseInstall(
  input: PreciseInstallInput,
  onSteps?: (steps: InstallProgressStep[]) => void
): Promise<PreciseInstallResult> {
  const steps: InstallProgressStep[] = [
    { id: "plan", status: "running", message: "Building install plan" },
    { id: "java", status: "pending", message: "Ensure Java runtime" },
    { id: "install", status: "pending", message: "Install server files" },
    { id: "eula", status: "pending", message: "Accept EULA" },
    { id: "start", status: "pending", message: "Trial start" }
  ];
  const emit = () => {
    if (onSteps) onSteps(steps.map((s) => ({ ...s })));
  };
  emit();

  const plan = await buildInstallPlan({
    loader: input.loader,
    mcVersion: input.mcVersion,
    buildId: input.buildId
  });
  markStep(steps, "plan", "done", `Plan ready: ${plan.title} (Java ${plan.recommendedJava})`);
  emit();

  const remoteService = RemoteServiceSubsystem.getInstance(input.daemonId);
  if (!remoteService) {
    markStep(steps, "java", "error", "Remote daemon not found");
    emit();
    return {
      ok: false,
      plan: { ...plan, dockerOptional: dockerHint(plan.recommendedJava) },
      steps,
      error: "Remote daemon not found"
    };
  }
  const remote = new RemoteRequest(remoteService);

  let javaInfo: EnsureJavaResult | null = null;
  let memory: AdaptiveMemory = adaptiveMemory(
    input.loader,
    Math.floor(os.totalmem() / 1024 / 1024),
    Math.floor(os.freemem() / 1024 / 1024)
  );

  if (!input.useDocker) {
    markStep(
      steps,
      "java",
      "running",
      `Ensuring Java ${plan.recommendedJava} on daemon (download if missing)`
    );
    emit();
    try {
      javaInfo = await remote.request<EnsureJavaResult>(
        "java_manager/ensure",
        { version: plan.recommendedJava },
        15 * 60_000
      );
      memory = adaptiveMemory(input.loader, javaInfo.hostMemoryMb, javaInfo.hostFreeMemoryMb);
      markStep(
        steps,
        "java",
        "done",
        `Java ${javaInfo.version} ready (${javaInfo.source}, id=${javaInfo.id}); heap ${memory.xms}/${memory.xmx}`
      );
      emit();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      markStep(steps, "java", "error", msg);
      emit();
      return {
        ok: false,
        plan: { ...plan, dockerOptional: dockerHint(plan.recommendedJava) },
        steps,
        java: javaInfo,
        memory,
        error: `Failed to ensure Java ${plan.recommendedJava}: ${msg}`
      };
    }
  } else {
    markStep(steps, "java", "skipped", "Docker mode uses Temurin image Java");
    emit();
    memory = adaptiveMemory(
      input.loader,
      Math.floor(os.totalmem() / 1024 / 1024),
      Math.floor(os.freemem() / 1024 / 1024)
    );
  }

  const runtimePlan: McInstallPlan = applyRuntimeToPlan(plan, {
    javaId: javaInfo?.id,
    memory
  });

  const setupInfo: Partial<IGlobalInstanceConfig> = {
    ...runtimePlan.setupInfo
  };
  if (input.useDocker) {
    const docker = dockerHint(plan.recommendedJava);
    setupInfo.processType = "docker";
    setupInfo.docker = { ...docker };
    if (setupInfo.startCommand) {
      setupInfo.startCommand = setupInfo.startCommand.split("{mcsm_java}").join("java");
    }
    if (setupInfo.updateCommand) {
      setupInfo.updateCommand = setupInfo.updateCommand.split("{mcsm_java}").join("java");
    }
  }

  markStep(steps, "install", "running", "Starting quick_install task");
  emit();

  let task: InstallTaskResult;
  try {
    const result = await remote.request<InstallTaskResult>(
      "instance/asynchronous",
      {
        instanceUuid: "-",
        taskName: "quick_install",
        parameter: {
          newInstanceName: input.newInstanceName,
          targetLink: plan.targetLink,
          setupInfo
        },
        role: ROLE.ADMIN
      },
      60_000
    );
    task = result || {};
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    markStep(steps, "install", "error", msg);
    emit();
    return {
      ok: false,
      plan: { ...runtimePlan, dockerOptional: dockerHint(plan.recommendedJava) },
      steps,
      java: javaInfo,
      memory,
      error: msg
    };
  }

  const instanceUuid = task.instanceUuid;
  if (!instanceUuid) {
    markStep(steps, "install", "error", "Install task did not return instanceUuid");
    emit();
    return {
      ok: false,
      plan: { ...runtimePlan, dockerOptional: dockerHint(plan.recommendedJava) },
      task,
      steps,
      java: javaInfo,
      memory,
      error: "Install task did not return instanceUuid"
    };
  }

  if (!input.useDocker && javaInfo?.id) {
    try {
      await remote.request(
        "instance/update",
        {
          instanceUuid,
          config: {
            java: { id: javaInfo.id },
            startCommand: setupInfo.startCommand,
            updateCommand: setupInfo.updateCommand
          }
        },
        20_000
      );
    } catch {
      // setupInfo should already include java id
    }
  }

  let installWait: { ok: boolean; status: number } = { ok: true, status: 1 };
  if (input.waitForInstall) {
    markStep(steps, "install", "running", "Waiting for installer/download to finish");
    emit();
    installWait = await waitForInstallTask(remote, task);
    if (installWait.ok) {
      markStep(steps, "install", "done", "Server files installed");
    } else {
      markStep(steps, "install", "error", `Install task finished with status=${installWait.status}`);
    }
    emit();
  } else {
    markStep(steps, "install", "done", "Install task started (not waiting)");
    emit();
  }

  let trial: TrialStartResult | undefined;
  if (input.waitForInstall && installWait.ok && input.autoStart) {
    markStep(steps, "eula", "running", "Writing eula.txt");
    emit();
    try {
      await writeEula(remote, instanceUuid);
      markStep(steps, "eula", "done", "EULA accepted");
      emit();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      markStep(steps, "eula", "error", msg);
      emit();
    }

    markStep(steps, "start", "running", "Trial starting instance");
    emit();
    trial = await trialStart(remote, instanceUuid);
    markStep(steps, "start", trial.ok ? "done" : "error", trial.message);
    emit();
  } else {
    markStep(
      steps,
      "eula",
      "skipped",
      input.autoStart ? "Skipped due to install state" : "autoStart disabled"
    );
    markStep(
      steps,
      "start",
      "skipped",
      input.autoStart ? "Skipped due to install state" : "autoStart disabled"
    );
    emit();
  }

  const ok =
    steps.every((s) => s.status === "done" || s.status === "skipped") &&
    (trial ? trial.ok : true) &&
    installWait.ok;

  return {
    ok,
    plan: {
      ...runtimePlan,
      dockerOptional: dockerHint(plan.recommendedJava)
    },
    task,
    java: javaInfo,
    memory,
    steps,
    trial,
    instanceUuid,
    error: ok ? undefined : trial?.message || "Install finished with errors"
  };
}

/**
 * Resolve a precise version plan, ensure required Java runtime, then start install.
 * Optionally waits for install completion, accepts EULA and trial-starts the instance.
 */
router.post(
  "/install",
  permission({ level: ROLE.MANAGER }),
  validator({
    query: { daemonId: String },
    body: {
      loader: String,
      mcVersion: String,
      newInstanceName: String
    }
  }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId || "");
    const body = (ctx.request.body ?? {}) as {
      loader?: string;
      mcVersion?: string;
      buildId?: string;
      newInstanceName?: string;
      useDocker?: boolean;
      autoStart?: boolean;
      waitForInstall?: boolean;
    };

    const loader = String(body.loader || "").toLowerCase();
    if (!isLoaderId(loader)) throw new Error(`Unsupported loader: ${loader}`);
    const name = String(body.newInstanceName || "").trim();
    if (!name) throw new Error("newInstanceName required");

    const result = await runPreciseInstall({
      daemonId,
      loader,
      mcVersion: String(body.mcVersion || ""),
      buildId: body.buildId ? String(body.buildId) : undefined,
      newInstanceName: name,
      useDocker: Boolean(body.useDocker),
      autoStart: body.autoStart !== false,
      waitForInstall: body.waitForInstall !== false
    });

    if (!result.ok) ctx.status = 500;
    ctx.body = result;
  }
);

/**
 * Streaming install with live step progress (SSE).
 * UI should prefer this over /install for progress feedback.
 */
router.post(
  "/install/stream",
  permission({ level: ROLE.MANAGER }),
  validator({
    query: { daemonId: String },
    body: {
      loader: String,
      mcVersion: String,
      newInstanceName: String
    }
  }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId || "");
    const body = (ctx.request.body ?? {}) as {
      loader?: string;
      mcVersion?: string;
      buildId?: string;
      newInstanceName?: string;
      useDocker?: boolean;
      autoStart?: boolean;
      waitForInstall?: boolean;
    };

    const loader = String(body.loader || "").toLowerCase();
    if (!isLoaderId(loader)) throw new Error(`Unsupported loader: ${loader}`);
    const name = String(body.newInstanceName || "").trim();
    if (!name) throw new Error("newInstanceName required");

    const { stream, writeEvent, end } = createInstallSseStream();
    ctx.status = 200;
    ctx.set("Content-Type", "text/event-stream; charset=utf-8");
    ctx.set("Cache-Control", "no-cache, no-transform");
    ctx.set("Connection", "keep-alive");
    ctx.set("X-Accel-Buffering", "no");
    ctx.body = stream;

    void (async () => {
      try {
        const result = await runPreciseInstall(
          {
            daemonId,
            loader,
            mcVersion: String(body.mcVersion || ""),
            buildId: body.buildId ? String(body.buildId) : undefined,
            newInstanceName: name,
            useDocker: Boolean(body.useDocker),
            autoStart: body.autoStart !== false,
            waitForInstall: body.waitForInstall !== false
          },
          (steps) => writeEvent({ type: "step", steps })
        );
        writeEvent({
          type: "result",
          ok: result.ok,
          plan: result.plan,
          task: result.task,
          java: result.java,
          memory: result.memory,
          steps: result.steps,
          trial: result.trial,
          instanceUuid: result.instanceUuid,
          error: result.error
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        writeEvent({ type: "error", message });
      } finally {
        end();
      }
    })();
  }
);

export default router;
