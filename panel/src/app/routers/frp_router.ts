import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import RemoteServiceSubsystem from "../service/remote_service";
import RemoteRequest from "../service/remote_command";
import FrpConfig, {
  getFrpConfig,
  initFrpConfig,
  saveFrpConfig,
  toPublicFrpConfig
} from "../service/frp_config_service";

const router = new Router({ prefix: "/frp" });

function eachRemoteService(): Array<{ id: string; service: any }> {
  const out: Array<{ id: string; service: any }> = [];
  const map = (RemoteServiceSubsystem as any).services;
  if (map && typeof map.forEach === "function") {
    map.forEach((service: any, id: string) => out.push({ id, service }));
  }
  return out;
}

async function pushConfigToDaemons(cfg: ReturnType<typeof getFrpConfig>) {
  const payload = {
    enabled: cfg.enabled,
    provider: cfg.provider,
    serverAddr: cfg.serverAddr,
    serverPort: cfg.serverPort,
    authToken: cfg.authToken,
    transport: cfg.transport,
    tlsEnable: cfg.tlsEnable,
    openFrpToken: cfg.openFrpToken,
    pricePerGb: cfg.pricePerGb,
    currency: cfg.currency
  };
  const results: any[] = [];
  for (const { id, service } of eachRemoteService()) {
    try {
      const data = await new RemoteRequest(service).request("frp/set_config", payload, 10_000);
      results.push({ ok: true, daemonId: id, data });
    } catch (e: any) {
      results.push({ ok: false, daemonId: id, message: e?.message || String(e) });
    }
  }
  return results;
}

router.get("/settings", permission({ level: ROLE.ADMIN }), async (ctx) => {
  initFrpConfig();
  ctx.body = toPublicFrpConfig(getFrpConfig());
});

router.put("/settings", permission({ level: ROLE.ADMIN }), async (ctx) => {
  initFrpConfig();
  const body = (ctx.request.body || {}) as any;
  const current = getFrpConfig();
  const next = new FrpConfig();
  next.enabled = body.enabled != null ? Boolean(body.enabled) : current.enabled;
  next.provider = body.provider === "openfrp" ? "openfrp" : "frp";
  next.serverAddr = body.serverAddr != null ? String(body.serverAddr) : current.serverAddr;
  next.serverPort = body.serverPort != null ? Number(body.serverPort) : current.serverPort;
  next.transport = body.transport != null ? String(body.transport) : current.transport;
  next.tlsEnable = body.tlsEnable != null ? Boolean(body.tlsEnable) : current.tlsEnable;
  next.pricePerGb = body.pricePerGb != null ? Number(body.pricePerGb) : current.pricePerGb;
  next.currency = body.currency != null ? String(body.currency) : current.currency;
  next.defaultEnableOnInstance =
    body.defaultEnableOnInstance != null
      ? Boolean(body.defaultEnableOnInstance)
      : current.defaultEnableOnInstance;
  next.authToken = current.authToken;
  next.openFrpToken = current.openFrpToken;
  if (body.clearAuthToken) next.authToken = "";
  if (typeof body.authToken === "string" && body.authToken.trim()) next.authToken = body.authToken.trim();
  if (body.clearOpenFrpToken) next.openFrpToken = "";
  if (typeof body.openFrpToken === "string" && body.openFrpToken.trim())
    next.openFrpToken = body.openFrpToken.trim();
  saveFrpConfig(next);
  const push = await pushConfigToDaemons(getFrpConfig());
  ctx.body = { ...toPublicFrpConfig(getFrpConfig()), push };
});

router.get("/traffic", permission({ level: ROLE.ADMIN }), async (ctx) => {
  // aggregate from all daemons
  const summaries: any[] = [];
  for (const { id, service } of eachRemoteService()) {
    try {
      const data = await new RemoteRequest(service).request("frp/traffic_summary", {}, 10_000);
      summaries.push({
        daemonId: id,
        remarks: service?.config?.remarks || "",
        ...data
      });
    } catch (e: any) {
      summaries.push({
        daemonId: id,
        error: e?.message || String(e)
      });
    }
  }

  // merge
  let liveRxRate = 0;
  let liveTxRate = 0;
  let online = 0;
  let error = 0;
  let totalTunnels = 0;
  let todayRx = 0;
  let todayTx = 0;
  let monthRx = 0;
  let monthTx = 0;
  const tunnels: any[] = [];
  const byInstanceMap = new Map<string, any>();

  for (const s of summaries) {
    if (s.error) continue;
    liveRxRate += Number(s.liveRxRate || 0);
    liveTxRate += Number(s.liveTxRate || 0);
    online += Number(s.online || 0);
    error += Number(s.error || 0);
    totalTunnels += Number(s.totalTunnels || 0);
    todayRx += Number(s.today?.rxBytes || 0);
    todayTx += Number(s.today?.txBytes || 0);
    monthRx += Number(s.month?.rxBytes || 0);
    monthTx += Number(s.month?.txBytes || 0);
    for (const t of s.tunnels || []) tunnels.push({ ...t, daemonId: s.daemonId });
    for (const row of s.month?.byInstance || []) {
      const key = `${s.daemonId}:${row.instanceUuid}`;
      const prev = byInstanceMap.get(key) || {
        ...row,
        daemonId: s.daemonId,
        totalBytes: 0
      };
      prev.rxBytes = Number(row.rxBytes || 0);
      prev.txBytes = Number(row.txBytes || 0);
      prev.totalBytes = prev.rxBytes + prev.txBytes;
      byInstanceMap.set(key, prev);
    }
  }

  const cfg = getFrpConfig();
  const monthGb = (monthRx + monthTx) / (1024 ** 3);
  const todayGb = (todayRx + todayTx) / (1024 ** 3);
  const price = Number(cfg.pricePerGb || 0);

  ctx.body = {
    enabled: cfg.enabled,
    online,
    error,
    totalTunnels,
    liveRxRate,
    liveTxRate,
    today: { rxBytes: todayRx, txBytes: todayTx, totalBytes: todayRx + todayTx },
    month: {
      rxBytes: monthRx,
      txBytes: monthTx,
      totalBytes: monthRx + monthTx,
      byInstance: Array.from(byInstanceMap.values()).sort((a, b) => b.totalBytes - a.totalBytes)
    },
    estimate: {
      currency: cfg.currency || "CNY",
      pricePerGb: price,
      todayCost: todayGb * price,
      monthCost: monthGb * price
    },
    tunnels,
    nodes: summaries,
    updatedAt: Date.now()
  };
});

router.get("/tunnels", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const all: any[] = [];
  for (const { id, service } of eachRemoteService()) {
    try {
      const data = await new RemoteRequest(service).request("frp/tunnels", {}, 10_000);
      for (const row of data || []) all.push({ ...row, daemonId: id });
    } catch {
      // skip offline node
    }
  }
  ctx.body = all;
});

export default router;
