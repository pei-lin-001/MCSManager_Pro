import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { isHaveInstanceByUuid, isTopPermissionByUuid } from "../service/permission_service";
import { getUserUuid } from "../service/passport_service";
import RemoteServiceSubsystem from "../service/remote_service";
import RemoteRequest from "../service/remote_command";
import { operationLogger } from "../service/operation_logger";
import fs from "fs-extra";
import path from "path";

const router = new Router({ prefix: "/protected_instance/backup" });

function assertAccess(ctx: any, daemonId: string, instanceUuid: string) {
  const userUuid = getUserUuid(ctx);
  if (!isTopPermissionByUuid(userUuid) && !isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)) {
    ctx.status = 403;
    throw new Error("Access denied for instance");
  }
}

async function remote(daemonId: string) {
  const service = RemoteServiceSubsystem.getInstance(daemonId);
  if (!service) throw new Error("Daemon not found");
  return new RemoteRequest(service);
}

router.get(
  "/list",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    assertAccess(ctx, daemonId, instanceUuid);
    ctx.body = await (await remote(daemonId)).request("instance/backup/list", { instanceUuid });
  }
);

router.get(
  "/settings",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    assertAccess(ctx, daemonId, instanceUuid);
    ctx.body = await (await remote(daemonId)).request("instance/backup/settings", { instanceUuid });
  }
);

router.put(
  "/settings",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    assertAccess(ctx, daemonId, instanceUuid);
    const keepCount = Number((ctx.request.body as any)?.keepCount);
    ctx.body = await (
      await remote(daemonId)
    ).request("instance/backup/settings", { instanceUuid, keepCount });
  }
);

router.post(
  "/create",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    assertAccess(ctx, daemonId, instanceUuid);
    const body = (ctx.request.body || {}) as any;
    const result = await (
      await remote(daemonId)
    ).request(
      "instance/backup/create",
      {
        instanceUuid,
        scope: body.scope || "core",
        note: body.note || "",
        trigger: "manual"
      },
      30 * 60_000
    );
    operationLogger.log("instance_file_update", {
      operator_ip: ctx.ip,
      operator_name: ctx.session?.["userName"],
      instance_id: instanceUuid,
      daemon_id: daemonId
    } as any);
    ctx.body = result;
  }
);

router.delete(
  "/",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String, backupId: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    const backupId = String(ctx.query.backupId);
    assertAccess(ctx, daemonId, instanceUuid);
    ctx.body = await (
      await remote(daemonId)
    ).request("instance/backup/delete", { instanceUuid, backupId });
  }
);

router.post(
  "/restore",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    assertAccess(ctx, daemonId, instanceUuid);
    const body = (ctx.request.body || {}) as any;
    const result = await (
      await remote(daemonId)
    ).request(
      "instance/backup/restore",
      {
        instanceUuid,
        backupId: body.backupId,
        autoStart: Boolean(body.autoStart),
        skipPreBackup: Boolean(body.skipPreBackup)
      },
      60 * 60_000
    );
    operationLogger.log("instance_file_update", {
      operator_ip: ctx.ip,
      operator_name: ctx.session?.["userName"],
      instance_id: instanceUuid,
      daemon_id: daemonId
    } as any);
    ctx.body = result;
  }
);

// local path helper for download via panel static/file channel if needed
router.get(
  "/download_info",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String, backupId: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId);
    const instanceUuid = String(ctx.query.uuid);
    const backupId = String(ctx.query.backupId);
    assertAccess(ctx, daemonId, instanceUuid);
    ctx.body = await (
      await remote(daemonId)
    ).request("instance/backup/file", { instanceUuid, backupId });
  }
);

export default router;
