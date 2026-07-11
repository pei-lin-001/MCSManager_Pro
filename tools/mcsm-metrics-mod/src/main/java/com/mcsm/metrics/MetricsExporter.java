package com.mcsm.metrics;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Lightweight always-on metrics writer for MCSManager.
 *
 * Output file (server root): mcsm-metrics.json
 */
public class MetricsExporter {
    private static final int TARGET_TPS = 20;
    private static final long WRITE_INTERVAL_MS = 2000L;
    private static final int TPS_WINDOW_TICKS = 100; // 5s at 20 TPS
    private static final int MSPT_WINDOW = 200; // 10s

    private final MinecraftServer server;
    private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();

    private long lastNano = 0L;
    private long tickCounter = 0L;
    private long lastWriteMs = 0L;

    private final Deque<Double> tpsSamples = new ArrayDeque<>();
    private final Deque<Double> msptSamples = new ArrayDeque<>();

    private long tickStartNano = 0L;
    private boolean started = false;

    public MetricsExporter(MinecraftServer server) {
        this.server = server;
    }

    public void start() {
        if (started) return;
        MinecraftForge.EVENT_BUS.register(this);
        started = true;
        lastNano = System.nanoTime();
        lastWriteMs = 0L;
    }

    public void stop() {
        if (!started) return;
        MinecraftForge.EVENT_BUS.unregister(this);
        started = false;
        // final flush
        try {
            writeSnapshot(true);
        } catch (Exception ignored) {
        }
    }

    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase == TickEvent.Phase.START) {
            tickStartNano = System.nanoTime();
            return;
        }
        if (event.phase != TickEvent.Phase.END) return;

        long now = System.nanoTime();
        if (tickStartNano > 0L) {
            double mspt = (now - tickStartNano) / 1_000_000.0;
            msptSamples.addLast(mspt);
            while (msptSamples.size() > MSPT_WINDOW) msptSamples.removeFirst();
        }

        tickCounter++;
        // Every 20 ticks estimate instantaneous TPS from wall clock for 1s window samples.
        if (tickCounter % 20 == 0) {
            if (lastNano > 0L) {
                double elapsedSec = (now - lastNano) / 1_000_000_000.0;
                if (elapsedSec > 0.0001) {
                    // 20 ticks took elapsedSec seconds => TPS = 20 / elapsedSec
                    double tps = Math.min(20.5, 20.0 / elapsedSec);
                    tpsSamples.addLast(tps);
                    while (tpsSamples.size() > 15) tpsSamples.removeFirst(); // ~15s window
                }
            }
            lastNano = now;
        }

        long nowMs = System.currentTimeMillis();
        if (nowMs - lastWriteMs >= WRITE_INTERVAL_MS) {
            lastWriteMs = nowMs;
            try {
                writeSnapshot(false);
            } catch (Exception e) {
                McsmMetricsMod.LOGGER.warn("Failed to write mcsm-metrics.json: {}", e.toString());
            }
        }
    }

    private double avg(Deque<Double> q) {
        if (q.isEmpty()) return 0.0;
        double s = 0.0;
        for (double v : q) s += v;
        return s / q.size();
    }

    private double percentile(Deque<Double> q, double p) {
        if (q.isEmpty()) return 0.0;
        List<Double> list = new ArrayList<>(q);
        list.sort(Double::compareTo);
        int idx = Math.min(list.size() - 1, Math.max(0, (int) Math.round((list.size() - 1) * p)));
        return list.get(idx);
    }

    private void writeSnapshot(boolean stopping) throws IOException {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("schema", 1);
        root.put("mod", "mcsm_metrics");
        root.put("modVersion", "0.1.0");
        root.put("ts", System.currentTimeMillis());
        root.put("stopping", stopping);

        double tps = tpsSamples.isEmpty() ? 20.0 : Math.min(20.5, avg(tpsSamples));
        double msptMed = msptSamples.isEmpty() ? 0.0 : percentile(msptSamples, 0.5);
        double msptP95 = msptSamples.isEmpty() ? 0.0 : percentile(msptSamples, 0.95);
        double msptMax = msptSamples.isEmpty() ? 0.0 : percentile(msptSamples, 1.0);

        Map<String, Object> perf = new LinkedHashMap<>();
        Map<String, Object> tpsObj = new LinkedHashMap<>();
        tpsObj.put("s5", round2(tps));
        tpsObj.put("s10", round2(tps));
        tpsObj.put("m1", round2(tps));
        perf.put("tps", tpsObj);

        Map<String, Object> msptObj = new LinkedHashMap<>();
        msptObj.put("med10s", round2(msptMed));
        msptObj.put("p95_10s", round2(msptP95));
        msptObj.put("max10s", round2(msptMax));
        perf.put("mspt", msptObj);
        perf.put("tickLoadPct", round2(Math.min(999.0, (msptMed / 50.0) * 100.0)));
        root.put("performance", perf);

        List<Map<String, Object>> players = new ArrayList<>();
        List<ServerPlayer> list = server.getPlayerList().getPlayers();
        for (ServerPlayer p : list) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", p.getGameProfile().getName());
            row.put("uuid", p.getGameProfile().getId().toString());
            // latency is kept by connection; field name depends on mappings (official: latency)
            int ping = 0;
            try {
                ping = p.latency;
            } catch (Throwable t) {
                try {
                    // fallback via reflection if field renamed
                    var f = p.getClass().getField("latency");
                    ping = f.getInt(p);
                } catch (Throwable ignored) {
                    ping = 0;
                }
            }
            row.put("pingMs", Math.max(0, ping));
            if (p.level() != null && p.level().dimension() != null) {
                row.put("dim", p.level().dimension().location().toString());
            }
            row.put("x", round2(p.getX()));
            row.put("y", round2(p.getY()));
            row.put("z", round2(p.getZ()));
            players.add(row);
        }
        root.put("playersOnline", players);
        root.put("playersOnlineCount", players.size());
        root.put("maxPlayers", server.getMaxPlayers());

        Path out = server.getServerDirectory().toPath().resolve("mcsm-metrics.json");
        Path tmp = server.getServerDirectory().toPath().resolve("mcsm-metrics.json.tmp");
        String json = gson.toJson(root);
        Files.writeString(tmp, json + "\n", StandardCharsets.UTF_8);
        try {
            Files.move(tmp, out, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ex) {
            Files.move(tmp, out, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
