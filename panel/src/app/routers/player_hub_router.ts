import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { getUserUuid } from "../service/passport_service";
import {
  bindMinecraftToUser,
  collectPlayerHubForUser,
  getBoundIdentity,
  unbindMinecraftFromUser
} from "../service/player_hub_service";
import { collectGlobalLeaderboard } from "../service/player_leaderboard_service";
import userSystem from "../service/user_service";

const router = new Router({ prefix: "/player_hub" });

router.get("/me", permission({ level: ROLE.USER, token: false }), async (ctx) => {
  const userUuid = getUserUuid(ctx);
  const user = userSystem.getInstance(userUuid);
  if (!user) {
    ctx.status = 404;
    ctx.body = { error: "User not found" };
    return;
  }
  ctx.body = {
    identity: getBoundIdentity(user),
    activityPoints: user.activityPoints || 0,
    checkIn: user.checkIn || {}
  };
});

router.post(
  "/bind",
  permission({ level: ROLE.USER }),
  validator({ body: { mcName: String } }),
  async (ctx) => {
    const userUuid = getUserUuid(ctx);
    const mcName = String((ctx.request.body as any)?.mcName || "");
    ctx.body = await bindMinecraftToUser(userUuid, mcName);
  }
);

router.delete("/bind", permission({ level: ROLE.USER }), async (ctx) => {
  const userUuid = getUserUuid(ctx);
  ctx.body = await unbindMinecraftFromUser(userUuid);
});

router.get("/profiles", permission({ level: ROLE.USER }), async (ctx) => {
  const userUuid = getUserUuid(ctx);
  ctx.body = await collectPlayerHubForUser(userUuid);
});

router.get("/leaderboard", permission({ level: ROLE.USER, token: false }), async (ctx) => {
  const q = ctx.query as Record<string, string | string[] | undefined>;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || "";
  ctx.body = await collectGlobalLeaderboard({
    metric: one(q.metric),
    limit: Number(one(q.limit) || 50),
    daemonId: one(q.daemonId),
    instanceUuid: one(q.instanceUuid)
  });
});

export default router;
