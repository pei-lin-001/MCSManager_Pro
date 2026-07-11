package com.mcsm.metrics;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.animal.horse.AbstractHorse;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.vehicle.Boat;
import net.minecraft.world.entity.vehicle.Minecart;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.ServerChatEvent;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.event.entity.living.LivingDeathEvent;
import net.minecraftforge.event.entity.living.LivingHurtEvent;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.event.entity.player.PlayerXpEvent;
import net.minecraftforge.event.level.BlockEvent;
import net.minecraftforge.event.entity.player.EntityItemPickupEvent;
import net.minecraftforge.event.CommandEvent;
import net.minecraftforge.eventbus.api.EventPriority;
import net.minecraftforge.eventbus.api.SubscribeEvent;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Live metrics + player profile tracker.
 *
 * Performance rules:
 * - Hot path only updates memory counters.
 * - Disk writes are throttled (live JSON 2s, dirty profiles 15s, full flush on quit/stop).
 * - Movement distance is sampled every 10 ticks, not every block event.
 */
public class MetricsService {
    private static final long LIVE_WRITE_MS = 2000L;
    private static final long PROFILE_FLUSH_MS = 15000L;
    private static final long AFK_AFTER_MS = 5 * 60 * 1000L;
    private static final int MOVE_SAMPLE_TICKS = 10;
    private static final int MSPT_WINDOW = 200;

    private final MinecraftServer server;
    private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();
    private final Map<UUID, PlayerProfile> profiles = new ConcurrentHashMap<>();

    private final Deque<Double> tpsSamples = new ArrayDeque<>();
    private final Deque<Double> msptSamples = new ArrayDeque<>();

    private long tickCounter = 0L;
    private long lastNano = 0L;
    private long tickStartNano = 0L;
    private long lastLiveWriteMs = 0L;
    private long lastProfileFlushMs = 0L;
    private boolean started = false;

    private Path dataDir;
    private Path playersDir;
    private Path liveFile;
    private Path liveTmp;

    public MetricsService(MinecraftServer server) {
        this.server = server;
    }

    public void start() {
        if (started) return;
        Path root = server.getServerDirectory().toPath();
        dataDir = root.resolve("mcsm-metrics");
        playersDir = dataDir.resolve("players");
        liveFile = root.resolve("mcsm-metrics.json");
        liveTmp = root.resolve("mcsm-metrics.json.tmp");
        try {
            Files.createDirectories(playersDir);
        } catch (IOException e) {
            McsmMetricsMod.LOGGER.error("Cannot create metrics dirs", e);
        }
        loadAllProfiles();
        MinecraftForge.EVENT_BUS.register(this);
        started = true;
        lastNano = System.nanoTime();
        // Mark currently online players (in case of reload mid-session — rare on dedicated).
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            onJoin(p);
        }
        McsmMetricsMod.LOGGER.info("Metrics data dir: {}", dataDir.toAbsolutePath());
    }

    public void stop() {
        if (!started) return;
        long now = System.currentTimeMillis();
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            onQuit(p, now);
        }
        flushAllProfiles(true);
        try {
            writeLiveJson(true);
        } catch (Exception ignored) {
        }
        MinecraftForge.EVENT_BUS.unregister(this);
        started = false;
    }

    // -------------------- ticks --------------------

    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase == TickEvent.Phase.START) {
            tickStartNano = System.nanoTime();
            return;
        }
        if (event.phase != TickEvent.Phase.END) return;

        long nowNano = System.nanoTime();
        if (tickStartNano > 0L) {
            double mspt = (nowNano - tickStartNano) / 1_000_000.0;
            msptSamples.addLast(mspt);
            while (msptSamples.size() > MSPT_WINDOW) msptSamples.removeFirst();
        }

        tickCounter++;
        if (tickCounter % 20 == 0) {
            if (lastNano > 0L) {
                double elapsedSec = (nowNano - lastNano) / 1_000_000_000.0;
                if (elapsedSec > 0.0001) {
                    double tps = Math.min(20.5, 20.0 / elapsedSec);
                    tpsSamples.addLast(tps);
                    while (tpsSamples.size() > 15) tpsSamples.removeFirst();
                }
            }
            lastNano = nowNano;
        }

        // Sample movement / AFK / session timers every 10 ticks (~0.5s)
        if (tickCounter % MOVE_SAMPLE_TICKS == 0) {
            sampleOnlinePlayers();
        }

        long nowMs = System.currentTimeMillis();
        if (nowMs - lastLiveWriteMs >= LIVE_WRITE_MS) {
            lastLiveWriteMs = nowMs;
            try {
                writeLiveJson(false);
            } catch (Exception e) {
                McsmMetricsMod.LOGGER.warn("live metrics write failed: {}", e.toString());
            }
        }
        if (nowMs - lastProfileFlushMs >= PROFILE_FLUSH_MS) {
            lastProfileFlushMs = nowMs;
            flushAllProfiles(false);
        }
    }

    private void sampleOnlinePlayers() {
        long now = System.currentTimeMillis();
        for (ServerPlayer sp : server.getPlayerList().getPlayers()) {
            PlayerProfile p = profiles.get(sp.getUUID());
            if (p == null || !p.online) continue;

            // session clocks
            long dt = Math.max(0, now - Math.max(p.lastActivityMs, p.sessionStartMs));
            // finer: accumulate since last sample using lastActivity marker
            // We track lastSample via lastMoveMs field reuse? use lastActivityMs delta carefully.
            // Simpler approach: each sample add MOVE_SAMPLE_TICKS * 50ms to session, split active/afk.
            long add = MOVE_SAMPLE_TICKS * 50L;
            p.sessionPlayMs += add;
            p.totalPlayMs += add;

            boolean isAfk = (now - p.lastMoveMs) >= AFK_AFTER_MS;
            if (isAfk) {
                p.afk = true;
                p.sessionAfkMs += add;
                p.totalAfkMs += add;
            } else {
                p.afk = false;
                p.sessionActiveMs += add;
                p.totalActiveMs += add;
            }

            // dimension time
            String dim = dimId(sp);
            if (p.currentDim == null) {
                p.currentDim = dim;
                p.dimSegmentStartMs = now;
            } else if (!p.currentDim.equals(dim)) {
                accrueDim(p, p.currentDim, now);
                p.currentDim = dim;
                p.dimSegmentStartMs = now;
            }

            // distance sample
            double x = sp.getX(), y = sp.getY(), z = sp.getZ();
            if (p.hasPrevPos) {
                double dx = x - p.prevX;
                double dy = y - p.prevY;
                double dz = z - p.prevZ;
                double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist > 0.01 && dist < 50.0) { // ignore teleports/spikes
                    classifyDistance(p, sp, dist, dy);
                    if (dist > 0.05) {
                        p.lastMoveMs = now;
                        p.lastActivityMs = now;
                    }
                } else if (dist >= 50.0) {
                    // teleport — don't count distance, but treat as activity
                    p.lastMoveMs = now;
                    p.lastActivityMs = now;
                }
            }
            p.prevX = x;
            p.prevY = y;
            p.prevZ = z;
            p.hasPrevPos = true;
            p.lastX = x;
            p.lastY = y;
            p.lastZ = z;
            p.lastDim = dim;

            // ping sample
            int ping = Math.max(0, sp.latency);
            p.pingSumSession += ping;
            p.pingSamplesSession++;
            if (ping > p.pingMaxSession) p.pingMaxSession = ping;
            p.lastPingSum += ping;
            p.lastPingSamples++;
            if (ping > p.lastPingMax) p.lastPingMax = ping;

            p.dirtyAt = now;
            p.name = sp.getGameProfile().getName();
        }
    }

    private void classifyDistance(PlayerProfile p, ServerPlayer sp, double dist, double dy) {
        if (sp.isFallFlying()) {
            p.distanceElytra += dist;
            return;
        }
        if (sp.isSwimming() || sp.isInWater()) {
            p.distanceSwim += dist;
            return;
        }
        Entity vehicle = sp.getVehicle();
        if (vehicle instanceof Boat) {
            p.distanceBoat += dist;
            return;
        }
        if (vehicle instanceof AbstractHorse) {
            p.distanceHorse += dist;
            return;
        }
        if (vehicle instanceof Minecart) {
            p.distanceMinecart += dist;
            return;
        }
        if (!sp.onGround() && dy > 0.1 && sp.getDeltaMovement().y > 0.1) {
            // crude flight / creative fly
            p.distanceFlown += dist;
            return;
        }
        if (sp.isCrouching()) {
            p.distanceCrouch += dist;
            return;
        }
        if (sp.isSprinting()) {
            p.distanceSprint += dist;
            return;
        }
        if (!sp.onGround() && dy < -0.2) {
            p.distanceFall += dist;
            return;
        }
        p.distanceWalked += dist;
    }

    private void accrueDim(PlayerProfile p, String dim, long now) {
        if (dim == null || p.dimSegmentStartMs <= 0) return;
        long add = Math.max(0, now - p.dimSegmentStartMs);
        if (add <= 0) return;
        p.dimensionTimeMs.merge(dim, add, Long::sum);
        p.dimSegmentStartMs = now;
    }

    private static String dimId(ServerPlayer sp) {
        try {
            return sp.level().dimension().location().toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    // -------------------- join / quit --------------------

    @SubscribeEvent
    public void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer sp)) return;
        onJoin(sp);
    }

    @SubscribeEvent
    public void onLogout(PlayerEvent.PlayerLoggedOutEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer sp)) return;
        onQuit(sp, System.currentTimeMillis());
    }

    private void onJoin(ServerPlayer sp) {
        long now = System.currentTimeMillis();
        PlayerProfile p = profiles.computeIfAbsent(sp.getUUID(),
            id -> loadProfile(id, sp.getGameProfile().getName(), now));
        p.name = sp.getGameProfile().getName();
        if (p.firstJoin <= 0) p.firstJoin = now;
        p.lastJoin = now;
        p.joinCount += 1;
        p.online = true;
        p.afk = false;
        p.sessionStartMs = now;
        p.sessionPlayMs = 0;
        p.sessionActiveMs = 0;
        p.sessionAfkMs = 0;
        p.lastMoveMs = now;
        p.lastActivityMs = now;
        p.currentDim = dimId(sp);
        p.dimSegmentStartMs = now;
        p.hasPrevPos = false;
        p.prevX = sp.getX();
        p.prevY = sp.getY();
        p.prevZ = sp.getZ();
        p.pingSumSession = 0;
        p.pingSamplesSession = 0;
        p.pingMaxSession = 0;
        p.dirtyAt = now;
        saveProfile(p, true);
    }

    private void onQuit(ServerPlayer sp, long now) {
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        if (p.online) {
            accrueDim(p, p.currentDim, now);
        }
        p.online = false;
        p.lastQuit = now;
        p.lastX = sp.getX();
        p.lastY = sp.getY();
        p.lastZ = sp.getZ();
        p.lastDim = dimId(sp);
        p.dirtyAt = now;
        saveProfile(p, true);
    }

    // -------------------- combat / death --------------------

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onDeath(LivingDeathEvent event) {
        if (event.isCanceled()) return;
        LivingEntity dead = event.getEntity();
        long now = System.currentTimeMillis();
        if (dead instanceof ServerPlayer victim) {
            PlayerProfile vp = profiles.get(victim.getUUID());
            if (vp != null) {
                vp.deaths += 1;
                vp.lastActivityMs = now;
                vp.dirtyAt = now;
            }
        }
        DamageSource src = event.getSource();
        Entity killer = src.getEntity();
        if (killer instanceof ServerPlayer attacker) {
            PlayerProfile ap = profiles.get(attacker.getUUID());
            if (ap != null) {
                if (dead instanceof Player) ap.playerKills += 1;
                else ap.mobKills += 1;
                ap.lastActivityMs = now;
                ap.dirtyAt = now;
            }
        }
    }

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onHurt(LivingHurtEvent event) {
        if (event.isCanceled()) return;
        float amount = event.getAmount();
        if (amount <= 0) return;
        long dmg = Math.round(amount);
        long now = System.currentTimeMillis();
        if (event.getEntity() instanceof ServerPlayer victim) {
            PlayerProfile vp = profiles.get(victim.getUUID());
            if (vp != null) {
                vp.damageTaken += dmg;
                vp.dirtyAt = now;
            }
        }
        Entity src = event.getSource().getEntity();
        if (src instanceof ServerPlayer attacker) {
            PlayerProfile ap = profiles.get(attacker.getUUID());
            if (ap != null) {
                ap.damageDealt += dmg;
                ap.lastActivityMs = now;
                ap.dirtyAt = now;
            }
        }
    }

    // -------------------- blocks / items / xp / chat / commands --------------------

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onBreak(BlockEvent.BreakEvent event) {
        if (event.isCanceled()) return;
        Player player = event.getPlayer();
        if (!(player instanceof ServerPlayer sp)) return;
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        p.blocksBroken += 1;
        p.lastActivityMs = System.currentTimeMillis();
        p.dirtyAt = p.lastActivityMs;
    }

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onPlace(BlockEvent.EntityPlaceEvent event) {
        if (event.isCanceled()) return;
        Entity e = event.getEntity();
        if (!(e instanceof ServerPlayer sp)) return;
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        p.blocksPlaced += 1;
        p.lastActivityMs = System.currentTimeMillis();
        p.dirtyAt = p.lastActivityMs;
    }

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onPickup(EntityItemPickupEvent event) {
        if (event.isCanceled()) return;
        Player player = event.getEntity();
        if (!(player instanceof ServerPlayer sp)) return;
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        p.itemsPicked += Math.max(1, event.getItem().getItem().getCount());
        p.lastActivityMs = System.currentTimeMillis();
        p.dirtyAt = p.lastActivityMs;
    }

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onXp(PlayerXpEvent.XpChange event) {
        if (!(event.getEntity() instanceof ServerPlayer sp)) return;
        int amt = event.getAmount();
        if (amt <= 0) return;
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        p.xpGained += amt;
        p.dirtyAt = System.currentTimeMillis();
    }

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onChat(ServerChatEvent event) {
        ServerPlayer sp = event.getPlayer();
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        p.chatMessages += 1;
        p.lastActivityMs = System.currentTimeMillis();
        p.dirtyAt = p.lastActivityMs;
    }

    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onCommand(CommandEvent event) {
        try {
            var source = event.getParseResults().getContext().getSource();
            Entity e = source.getEntity();
            if (!(e instanceof ServerPlayer sp)) return;
            PlayerProfile p = profiles.get(sp.getUUID());
            if (p == null) return;
            p.commandsUsed += 1;
            p.lastActivityMs = System.currentTimeMillis();
            p.dirtyAt = p.lastActivityMs;
        } catch (Throwable ignored) {
        }
    }

    // Crafting: approximate via inventory result slot close is complex; use container craft if available.
    // 1.20.1 forge has no single simple craft event for all cases; count item craft via PlayerEvent.ItemCraftedEvent
    @SubscribeEvent(priority = EventPriority.MONITOR)
    public void onCraft(PlayerEvent.ItemCraftedEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer sp)) return;
        PlayerProfile p = profiles.get(sp.getUUID());
        if (p == null) return;
        p.itemsCrafted += Math.max(1, event.getCrafting().getCount());
        p.lastActivityMs = System.currentTimeMillis();
        p.dirtyAt = p.lastActivityMs;
    }

    // -------------------- persistence --------------------

    private Path profilePath(UUID id) {
        return playersDir.resolve(id.toString() + ".json");
    }

    private PlayerProfile loadProfile(UUID id, String name, long now) {
        Path path = profilePath(id);
        if (Files.exists(path)) {
            try (Reader r = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
                PlayerProfile p = gson.fromJson(r, PlayerProfile.class);
                if (p != null) {
                    if (p.dimensionTimeMs == null) p.dimensionTimeMs = new HashMap<>();
                    if (p.uuid == null) p.uuid = id.toString();
                    if (p.name == null) p.name = name;
                    return p;
                }
            } catch (Exception e) {
                McsmMetricsMod.LOGGER.warn("Failed loading profile {}: {}", id, e.toString());
            }
        }
        return PlayerProfile.create(id, name, now);
    }

    private void loadAllProfiles() {
        if (!Files.isDirectory(playersDir)) return;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(playersDir, "*.json")) {
            for (Path path : ds) {
                try (Reader r = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
                    PlayerProfile p = gson.fromJson(r, PlayerProfile.class);
                    if (p == null || p.uuid == null) continue;
                    if (p.dimensionTimeMs == null) p.dimensionTimeMs = new HashMap<>();
                    p.online = false;
                    profiles.put(UUID.fromString(p.uuid), p);
                } catch (Exception ignored) {
                }
            }
        } catch (IOException ignored) {
        }
        McsmMetricsMod.LOGGER.info("Loaded {} player profiles", profiles.size());
    }

    private void saveProfile(PlayerProfile p, boolean force) {
        if (p == null || p.uuid == null) return;
        if (!force && p.dirtyAt <= 0) return;
        Path path = profilePath(UUID.fromString(p.uuid));
        Path tmp = playersDir.resolve(p.uuid + ".json.tmp");
        // Build a persistence-friendly object (avoid transient noise by using gson on fields)
        try {
            // Ensure dimension accrual for online before save
            if (p.online) {
                accrueDim(p, p.currentDim, System.currentTimeMillis());
            }
            String json = gson.toJson(toPersistMap(p));
            Files.writeString(tmp, json + "\n", StandardCharsets.UTF_8);
            try {
                Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException ex) {
                Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
            }
            p.dirtyAt = 0;
        } catch (Exception e) {
            McsmMetricsMod.LOGGER.warn("save profile {} failed: {}", p.uuid, e.toString());
        }
    }

    private Map<String, Object> toPersistMap(PlayerProfile p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("uuid", p.uuid);
        m.put("name", p.name);
        m.put("firstJoin", p.firstJoin);
        m.put("lastJoin", p.lastJoin);
        m.put("lastQuit", p.lastQuit);
        m.put("joinCount", p.joinCount);
        m.put("totalPlayMs", p.totalPlayMs);
        m.put("totalActiveMs", p.totalActiveMs);
        m.put("totalAfkMs", p.totalAfkMs);
        m.put("deaths", p.deaths);
        m.put("playerKills", p.playerKills);
        m.put("mobKills", p.mobKills);
        m.put("damageDealt", p.damageDealt);
        m.put("damageTaken", p.damageTaken);
        m.put("blocksBroken", p.blocksBroken);
        m.put("blocksPlaced", p.blocksPlaced);
        m.put("itemsCrafted", p.itemsCrafted);
        m.put("itemsPicked", p.itemsPicked);
        m.put("chatMessages", p.chatMessages);
        m.put("commandsUsed", p.commandsUsed);
        m.put("xpGained", p.xpGained);
        m.put("distanceWalked", round2(p.distanceWalked));
        m.put("distanceFlown", round2(p.distanceFlown));
        m.put("distanceElytra", round2(p.distanceElytra));
        m.put("distanceBoat", round2(p.distanceBoat));
        m.put("distanceHorse", round2(p.distanceHorse));
        m.put("distanceMinecart", round2(p.distanceMinecart));
        m.put("distanceSwim", round2(p.distanceSwim));
        m.put("distanceSprint", round2(p.distanceSprint));
        m.put("distanceCrouch", round2(p.distanceCrouch));
        m.put("distanceFall", round2(p.distanceFall));
        m.put("distanceTotal", p.totalDistanceRounded());
        m.put("dimensionTimeMs", p.dimensionTimeMs);
        m.put("lastDim", p.lastDim);
        m.put("lastX", round2(p.lastX));
        m.put("lastY", round2(p.lastY));
        m.put("lastZ", round2(p.lastZ));
        m.put("lastPingAvg", round2(p.avgPing()));
        m.put("lastPingMax", p.lastPingMax);
        m.put("lastPingSamples", p.lastPingSamples);
        return m;
    }

    private void flushAllProfiles(boolean force) {
        for (PlayerProfile p : profiles.values()) {
            if (force || p.dirtyAt > 0) saveProfile(p, force);
        }
    }

    // -------------------- live json --------------------

    private void writeLiveJson(boolean stopping) throws IOException {
        long now = System.currentTimeMillis();
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("schema", 2);
        root.put("mod", "mcsm_metrics");
        root.put("modVersion", "0.2.0");
        root.put("ts", now);
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

        List<Map<String, Object>> online = new ArrayList<>();
        for (ServerPlayer sp : server.getPlayerList().getPlayers()) {
            PlayerProfile p = profiles.get(sp.getUUID());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", sp.getGameProfile().getName());
            row.put("uuid", sp.getUUID().toString());
            row.put("pingMs", Math.max(0, sp.latency));
            row.put("dim", dimId(sp));
            row.put("x", round2(sp.getX()));
            row.put("y", round2(sp.getY()));
            row.put("z", round2(sp.getZ()));
            if (p != null) {
                row.put("afk", p.afk);
                row.put("sessionPlayMs", p.sessionPlayMs);
                row.put("sessionActiveMs", p.sessionActiveMs);
                row.put("sessionAfkMs", p.sessionAfkMs);
                row.put("totalPlayMs", p.totalPlayMs);
                row.put("totalActiveMs", p.totalActiveMs);
                row.put("totalAfkMs", p.totalAfkMs);
                row.put("deaths", p.deaths);
                row.put("playerKills", p.playerKills);
                row.put("mobKills", p.mobKills);
                row.put("blocksBroken", p.blocksBroken);
                row.put("blocksPlaced", p.blocksPlaced);
                row.put("distanceTotal", p.totalDistanceRounded());
                row.put("joinCount", p.joinCount);
                row.put("firstJoin", p.firstJoin);
                row.put("lastJoin", p.lastJoin);
            }
            online.add(row);
        }
        root.put("playersOnline", online);
        root.put("playersOnlineCount", online.size());
        root.put("maxPlayers", server.getMaxPlayers());

        // Rankings from all known profiles (cheap; profile count usually small)
        root.put("rankings", buildRankings());

        String json = gson.toJson(root);
        Files.writeString(liveTmp, json + "\n", StandardCharsets.UTF_8);
        try {
            Files.move(liveTmp, liveFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ex) {
            Files.move(liveTmp, liveFile, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private Map<String, Object> buildRankings() {
        List<PlayerProfile> all = new ArrayList<>(profiles.values());
        Map<String, Object> ranks = new LinkedHashMap<>();
        ranks.put("playtime", top(all, Comparator.comparingLong((PlayerProfile p) -> p.totalPlayMs).reversed(), "totalPlayMs"));
        ranks.put("activePlaytime", top(all, Comparator.comparingLong((PlayerProfile p) -> p.totalActiveMs).reversed(), "totalActiveMs"));
        ranks.put("distance", top(all, Comparator.comparingLong(PlayerProfile::totalDistanceRounded).reversed(), "distanceTotal"));
        ranks.put("deaths", top(all, Comparator.comparingLong((PlayerProfile p) -> p.deaths).reversed(), "deaths"));
        ranks.put("playerKills", top(all, Comparator.comparingLong((PlayerProfile p) -> p.playerKills).reversed(), "playerKills"));
        ranks.put("mobKills", top(all, Comparator.comparingLong((PlayerProfile p) -> p.mobKills).reversed(), "mobKills"));
        ranks.put("blocksBroken", top(all, Comparator.comparingLong((PlayerProfile p) -> p.blocksBroken).reversed(), "blocksBroken"));
        ranks.put("blocksPlaced", top(all, Comparator.comparingLong((PlayerProfile p) -> p.blocksPlaced).reversed(), "blocksPlaced"));
        ranks.put("xpGained", top(all, Comparator.comparingLong((PlayerProfile p) -> p.xpGained).reversed(), "xpGained"));
        return ranks;
    }

    private List<Map<String, Object>> top(List<PlayerProfile> all, Comparator<PlayerProfile> cmp, String valueKey) {
        return all.stream()
            .sorted(cmp)
            .limit(10)
            .map(p -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", p.name);
                m.put("uuid", p.uuid);
                Object val = switch (valueKey) {
                    case "totalPlayMs" -> p.totalPlayMs;
                    case "totalActiveMs" -> p.totalActiveMs;
                    case "distanceTotal" -> p.totalDistanceRounded();
                    case "deaths" -> p.deaths;
                    case "playerKills" -> p.playerKills;
                    case "mobKills" -> p.mobKills;
                    case "blocksBroken" -> p.blocksBroken;
                    case "blocksPlaced" -> p.blocksPlaced;
                    case "xpGained" -> p.xpGained;
                    default -> 0;
                };
                m.put("value", val);
                return m;
            })
            .toList();
    }

    private double avg(Deque<Double> q) {
        if (q.isEmpty()) return 0;
        double s = 0;
        for (double v : q) s += v;
        return s / q.size();
    }

    private double percentile(Deque<Double> q, double p) {
        if (q.isEmpty()) return 0;
        List<Double> list = new ArrayList<>(q);
        list.sort(Double::compareTo);
        int idx = Math.min(list.size() - 1, Math.max(0, (int) Math.round((list.size() - 1) * p)));
        return list.get(idx);
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
