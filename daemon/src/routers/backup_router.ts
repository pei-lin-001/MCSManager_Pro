import { $t } from "../i18n";
import { routerApp } from "../service/router";
import * as protocol from "../service/protocol";
import backupService from "../service/backup_service";
import InstanceSubsystem from "../service/system_instance";
import fs from "fs-extra";

function ensureInstance(uuid: string) {
  const inst = InstanceSubsystem.getInstance(uuid);
  if (!inst) throw new Error($t("TXT_CODE_3bfb9e04") || "Instance not found");
  return inst;
}

routerApp.on("instance/backup/list", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    ensureInstance(instanceUuid);
    protocol.response(ctx, await backupService.list(instanceUuid));
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("instance/backup/settings", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    ensureInstance(instanceUuid);
    if (data?.keepCount != null) {
      protocol.response(ctx, await backupService.setKeepCount(instanceUuid, Number(data.keepCount)));
    } else {
      protocol.response(ctx, await backupService.getSettings(instanceUuid));
    }
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("instance/backup/create", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    ensureInstance(instanceUuid);
    const record = await backupService.create(instanceUuid, {
      scope: data?.scope,
      note: data?.note,
      trigger: data?.trigger || "manual",
      keepCount: data?.keepCount
    });
    protocol.response(ctx, record);
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("instance/backup/delete", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    const backupId = String(data?.backupId || "");
    ensureInstance(instanceUuid);
    protocol.response(ctx, await backupService.remove(instanceUuid, backupId));
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("instance/backup/restore", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    const backupId = String(data?.backupId || "");
    ensureInstance(instanceUuid);
    const result = await backupService.restore(instanceUuid, backupId, {
      autoStart: Boolean(data?.autoStart),
      skipPreBackup: Boolean(data?.skipPreBackup)
    });
    protocol.response(ctx, result);
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("instance/backup/file", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    const backupId = String(data?.backupId || "");
    ensureInstance(instanceUuid);
    const fp = backupService.getFilePath(instanceUuid, backupId);
    if (!(await fs.pathExists(fp))) throw new Error("Backup file not found");
    protocol.response(ctx, { path: fp, exists: true });
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});
