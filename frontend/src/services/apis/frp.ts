import { useDefineApi } from "@/stores/useDefineApi";

export type FrpProvider = "frp" | "openfrp";

export interface FrpPublicSettings {
  enabled: boolean;
  provider: FrpProvider;
  serverAddr: string;
  serverPort: number;
  transport: string;
  tlsEnable: boolean;
  hasAuthToken: boolean;
  hasOpenFrpToken: boolean;
  pricePerGb: number;
  currency: string;
  defaultEnableOnInstance: boolean;
}

export interface FrpTrafficSummary {
  enabled: boolean;
  online: number;
  error: number;
  totalTunnels: number;
  liveRxRate: number;
  liveTxRate: number;
  today: { rxBytes: number; txBytes: number; totalBytes: number };
  month: {
    rxBytes: number;
    txBytes: number;
    totalBytes: number;
    byInstance: Array<{
      instanceUuid: string;
      daemonId?: string;
      nickname?: string;
      rxBytes: number;
      txBytes: number;
      totalBytes: number;
      localPort?: number;
      remotePort?: number;
    }>;
  };
  estimate: {
    currency: string;
    pricePerGb: number;
    todayCost: number;
    monthCost: number;
  };
  tunnels: any[];
  updatedAt: number;
}

export const getFrpSettings = useDefineApi<undefined, FrpPublicSettings>({
  url: "/api/frp/settings",
  method: "GET"
});

export const updateFrpSettings = useDefineApi<
  {
    data: Partial<FrpPublicSettings> & {
      authToken?: string;
      openFrpToken?: string;
      clearAuthToken?: boolean;
      clearOpenFrpToken?: boolean;
    };
  },
  FrpPublicSettings & { push?: any }
>({
  url: "/api/frp/settings",
  method: "PUT"
});

export const getFrpTraffic = useDefineApi<undefined, FrpTrafficSummary>({
  url: "/api/frp/traffic",
  method: "GET"
});

export const getFrpTunnels = useDefineApi<undefined, any[]>({
  url: "/api/frp/tunnels",
  method: "GET"
});
