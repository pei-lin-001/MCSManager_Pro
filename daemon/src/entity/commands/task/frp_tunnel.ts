import { ILifeCycleTask } from "../../instance/life_cycle";
import Instance from "../../instance/instance";
import frpManager from "../../../service/frp_manager";

/**
 * Starts/stops FRP tunnel with instance lifecycle.
 * High-precision traffic is measured by TcpTrafficCounterProxy inside FrpManager.
 */
export default class FrpTunnelTask implements ILifeCycleTask {
  public status = 0;
  public name = "frp_tunnel";

  async start(instance: Instance) {
    try {
      await frpManager.startForInstance(instance);
    } catch (error: any) {
      instance.println("FRP", `lifecycle start error: ${error?.message || error}`);
    }
  }

  async stop(instance: Instance) {
    try {
      await frpManager.stopForInstance(instance.instanceUuid);
      if ((instance.info as any).tunnel) {
        (instance.info as any).tunnel.status = "off";
      }
      (instance.info as any).openFrpStatus = false;
    } catch {
      // ignore
    }
  }
}
