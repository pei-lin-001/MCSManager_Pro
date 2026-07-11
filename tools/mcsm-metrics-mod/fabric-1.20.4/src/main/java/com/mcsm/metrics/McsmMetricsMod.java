package com.mcsm.metrics;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class McsmMetricsMod implements DedicatedServerModInitializer {
    public static final String MODID = "mcsm_metrics";
    public static final Logger LOGGER = LoggerFactory.getLogger("mcsm_metrics");

    private static MetricsService service;

    @Override
    public void onInitializeServer() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            if (service != null) {
                service.stop();
            }
            service = new MetricsService(server);
            service.start();
            LOGGER.info("MCSM Metrics Fabric v0.2.1 started");
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            if (service != null) {
                service.stop();
                service = null;
                LOGGER.info("MCSM Metrics Fabric stopped");
            }
        });
    }
}
