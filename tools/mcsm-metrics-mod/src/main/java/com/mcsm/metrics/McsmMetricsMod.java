package com.mcsm.metrics;

import com.mojang.logging.LogUtils;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.server.ServerStartingEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import org.slf4j.Logger;

@Mod(McsmMetricsMod.MODID)
public class McsmMetricsMod {
    public static final String MODID = "mcsm_metrics";
    public static final Logger LOGGER = LogUtils.getLogger();

    private MetricsService service;

    public McsmMetricsMod() {
        MinecraftForge.EVENT_BUS.register(this);
    }

    @SubscribeEvent
    public void onServerStarting(ServerStartingEvent event) {
        if (service != null) {
            service.stop();
        }
        service = new MetricsService(event.getServer());
        service.start();
        LOGGER.info("MCSM Metrics v0.2.0 started (live JSON + player profiles)");
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        if (service != null) {
            service.stop();
            service = null;
            LOGGER.info("MCSM Metrics stopped");
        }
    }
}
