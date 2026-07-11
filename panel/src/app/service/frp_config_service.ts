import StorageSystem from "../common/system_storage";

export type FrpProvider = "frp" | "openfrp";

export default class FrpConfig {
  enabled = false;
  provider: FrpProvider = "frp";
  serverAddr = "";
  serverPort = 7000;
  authToken = "";
  transport = "tcp";
  tlsEnable = false;
  openFrpToken = "";
  pricePerGb = 0;
  currency = "CNY";
  // default for new instances
  defaultEnableOnInstance = false;
}

let frpConfig: FrpConfig | null = null;

function hydrate(raw: any): FrpConfig {
  const c = new FrpConfig();
  c.enabled = Boolean(raw?.enabled);
  c.provider = raw?.provider === "openfrp" ? "openfrp" : "frp";
  c.serverAddr = String(raw?.serverAddr || "");
  c.serverPort = Number(raw?.serverPort || 7000) || 7000;
  c.authToken = String(raw?.authToken || "");
  c.transport = String(raw?.transport || "tcp");
  c.tlsEnable = Boolean(raw?.tlsEnable);
  c.openFrpToken = String(raw?.openFrpToken || "");
  c.pricePerGb = Number(raw?.pricePerGb || 0) || 0;
  c.currency = String(raw?.currency || "CNY");
  c.defaultEnableOnInstance = Boolean(raw?.defaultEnableOnInstance);
  return c;
}

export function initFrpConfig(): FrpConfig {
  const loaded = StorageSystem.load("FrpConfig", FrpConfig, "frp");
  if (loaded) {
    frpConfig = hydrate(loaded);
    return frpConfig;
  }
  frpConfig = new FrpConfig();
  StorageSystem.store("FrpConfig", "frp", frpConfig);
  return frpConfig;
}

export function getFrpConfig(): FrpConfig {
  if (!frpConfig) return initFrpConfig();
  return frpConfig;
}

export function saveFrpConfig(config: FrpConfig) {
  frpConfig = hydrate(config);
  StorageSystem.store("FrpConfig", "frp", frpConfig);
}

export function toPublicFrpConfig(config: FrpConfig) {
  return {
    enabled: Boolean(config.enabled),
    provider: config.provider,
    serverAddr: config.serverAddr,
    serverPort: config.serverPort,
    transport: config.transport,
    tlsEnable: Boolean(config.tlsEnable),
    hasAuthToken: Boolean(config.authToken),
    hasOpenFrpToken: Boolean(config.openFrpToken),
    pricePerGb: Number(config.pricePerGb) || 0,
    currency: config.currency || "CNY",
    defaultEnableOnInstance: Boolean(config.defaultEnableOnInstance)
  };
}
