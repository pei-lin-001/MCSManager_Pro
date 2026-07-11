import { $t } from "../i18n";
import { routerApp } from "../service/router";
import * as protocol from "../service/protocol";
import frpManager, { type FrpGlobalConfig } from "../service/frp_manager";
import InstanceSubsystem from "../service/system_instance";

routerApp.on("frp/get_config", async (ctx) => {
  try {
    protocol.response(ctx, frpManager.getPublicGlobalConfig());
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("frp/set_config", async (ctx, data) => {
  try {
    const body = (data || {}) as Partial<FrpGlobalConfig> & {
      authToken?: string;
      openFrpToken?: string;
      clearAuthToken?: boolean;
      clearOpenFrpToken?: boolean;
    };
    const current = frpManager.getGlobalConfig();
    const next: FrpGlobalConfig = {
      ...current,
      enabled: body.enabled != null ? Boolean(body.enabled) : current.enabled,
      provider: (body.provider as any) || current.provider,
      serverAddr: body.serverAddr != null ? String(body.serverAddr) : current.serverAddr,
      serverPort: body.serverPort != null ? Number(body.serverPort) : current.serverPort,
      transport: body.transport != null ? String(body.transport) : current.transport,
      tlsEnable: body.tlsEnable != null ? Boolean(body.tlsEnable) : current.tlsEnable,
      pricePerGb: body.pricePerGb != null ? Number(body.pricePerGb) : current.pricePerGb,
      currency: body.currency != null ? String(body.currency) : current.currency,
      frpcPath: body.frpcPath != null ? String(body.frpcPath) : current.frpcPath,
      authToken: current.authToken,
      openFrpToken: current.openFrpToken
    };
    if (body.clearAuthToken) next.authToken = "";
    if (typeof body.authToken === "string" && body.authToken.trim()) {
      next.authToken = body.authToken.trim();
    }
    if (body.clearOpenFrpToken) next.openFrpToken = "";
    if (typeof body.openFrpToken === "string" && body.openFrpToken.trim()) {
      next.openFrpToken = body.openFrpToken.trim();
    }
    frpManager.setGlobalConfig(next);
    // persist lightly beside runtime
    protocol.response(ctx, frpManager.getPublicGlobalConfig());
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("frp/tunnels", async (ctx) => {
  try {
    protocol.response(ctx, frpManager.list());
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("frp/traffic_summary", async (ctx) => {
  try {
    protocol.response(ctx, frpManager.getTrafficSummary());
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("frp/traffic_series", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    const limit = Number(data?.limit || 120);
    if (!instanceUuid) throw new Error($t("TXT_CODE_e6d73ce4") || "instanceUuid required");
    protocol.response(ctx, frpManager.getInstanceSeries(instanceUuid, limit));
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("frp/start_instance", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (!instance) throw new Error("instance not found");
    await frpManager.startForInstance(instance);
    protocol.response(ctx, frpManager.get(instanceUuid));
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});

routerApp.on("frp/stop_instance", async (ctx, data) => {
  try {
    const instanceUuid = String(data?.instanceUuid || "");
    await frpManager.stopForInstance(instanceUuid);
    protocol.response(ctx, true);
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});
