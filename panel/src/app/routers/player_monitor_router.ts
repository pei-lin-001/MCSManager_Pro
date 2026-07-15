import Router from "@koa/router";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { operationLogger } from "../service/operation_logger";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid } from "../service/permission_service";
import {
  collectPlayerMonitor,
  readPlayerProfile,
  runPlayerAction,
  type PlayerActionType,
  type PlayerMonitorMode
} from "../service/player_monitor_service";

const router = new Router({ prefix: "/player_monitor" });

const ACTION_TYPES = new Set<PlayerActionType>([
  "op",
  "deop",
  "kick",
  "ban",
  "pardon",
  "whitelist_add",
  "whitelist_remove",
  "kill",
  "clear_inventory",
  "gamemode_survival",
  "gamemode_creative",
  "gamemode_spectator"
]);

function assertInstanceAccess(userUuid: string, daemonId: string, instanceUuid: string): void {
  if (!isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)) {
    throw new Error($t("TXT_CODE_permission.forbiddenInstance"));
  }
}

router.get(
  "/snapshot",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId || "");
    const instanceUuid = String(ctx.query.uuid || "");
    const modeRaw = String(ctx.query.mode || "full").toLowerCase();
    const mode: PlayerMonitorMode = modeRaw === "fast" ? "fast" : "full";
    const userUuid = getUserUuid(ctx);
    assertInstanceAccess(userUuid, daemonId, instanceUuid);
    ctx.body = await collectPlayerMonitor(daemonId, instanceUuid, mode);
  }
);

router.get(
  "/profile",
  permission({ level: ROLE.MANAGER }),
  validator({ query: { daemonId: String, uuid: String, playerUuid: String } }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId || "");
    const instanceUuid = String(ctx.query.uuid || "");
    const playerUuid = String(ctx.query.playerUuid || "");
    const userUuid = getUserUuid(ctx);
    assertInstanceAccess(userUuid, daemonId, instanceUuid);
    const profile = await readPlayerProfile(daemonId, instanceUuid, playerUuid);
    if (!profile) {
      ctx.status = 404;
      ctx.body = { error: "Player profile not found" };
      return;
    }
    ctx.body = profile;
  }
);

router.post(
  "/action",
  permission({ level: ROLE.MANAGER }),
  validator({
    query: { daemonId: String, uuid: String },
    body: { action: String, player: String }
  }),
  async (ctx) => {
    const daemonId = String(ctx.query.daemonId || "");
    const instanceUuid = String(ctx.query.uuid || "");
    const userUuid = getUserUuid(ctx);
    assertInstanceAccess(userUuid, daemonId, instanceUuid);

    const body = ctx.request.body as {
      action?: string;
      player?: string;
      reason?: string;
    };
    const action = String(body.action || "") as PlayerActionType;
    const player = String(body.player || "").trim();
    const reason = body.reason != null ? String(body.reason) : undefined;

    if (!ACTION_TYPES.has(action)) {
      throw new Error("Unsupported player action");
    }
    if (!player) throw new Error("Player name is required");

    const result = await runPlayerAction({
      daemonId,
      instanceUuid,
      action,
      player,
      reason
    });

    operationLogger.log("instance_config_change", {
      daemon_id: daemonId,
      instance_id: instanceUuid,
      operator_ip: ctx.ip,
      operator_name: ctx.session?.["userName"]
    });
    ctx.body = result;
  }
);

export default router;
