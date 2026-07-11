package com.mcsm.metrics;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityCombatEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.block.BlockState;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.damage.DamageSource;
import net.minecraft.entity.passive.AbstractHorseEntity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.entity.vehicle.BoatEntity;
import net.minecraft.entity.vehicle.MinecartEntity;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.ActionResult;
import net.minecraft.util.TypedActionResult;
import net.minecraft.util.math.BlockPos;

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
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fabric port of MCSM metrics service.
 * Same JSON schema as Forge version (schema=2).
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
        Path root = server.getRunDirectory().toPath();
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
        registerEvents();
        started = true;
        lastNano = System.nanoTime();
        for (ServerPlayerEntity p : server.getPlayerManager().getPlayerList()) {
            onJoin(p);
        }
        McsmMetricsMod.LOGGER.info("Metrics data dir: {}", dataDir.toAbsolutePath());
    }

    public void stop() {
        if (!started) return;
        long now = System.currentTimeMillis();
        for (ServerPlayerEntity p : server.getPlayerManager().getPlayerList()) {
            onQuit(p, now);
        }
        flushAllProfiles(true);
        try {
            writeLiveJson(true);
        } catch (Exception ignored) {
        }
        started = false;
    }

    private void registerEvents() {
        ServerTickEvents.START_SERVER_TICK.register(s -> {
            if (s != server || !started) return;
            tickStartNano = System.nanoTime();
        });
        ServerTickEvents.END_SERVER_TICK.register(s -> {
            if (s != server || !started) return;
            onEndTick();
        });

        ServerPlayConnectionEvents.JOIN.register((handler, sender, server1) -> {
            if (!started) return;
            onJoin(handler.player);
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server1) -> {
            if (!started) return;
            onQuit(handler.player, System.currentTimeMillis());
        });

        ServerLivingEntityEvents.AFTER_DEATH.register((entity, damageSource) -> {
            if (!started) return;
            onDeath(entity, damageSource);
        });
        // damage taken/dealt approx via allow-damage callback after amount known is limited;
        // use combat kill event + block/chat for primary stats.

        PlayerBlockBreakEvents.AFTER.register((world, player, pos, state, blockEntity) -> {
            if (!started) return;
            if (!(player instanceof ServerPlayerEntity sp)) return;
            PlayerProfile p = profiles.get(sp.getUuid());
            if (p == null) return;
            p.blocksBroken += 1;
            p.lastActivityMs = System.currentTimeMillis();
            p.dirtyAt = p.lastActivityMs;
        });

        // Block place tracking for Fabric:
        // There is no full after-place event like Forge EntityPlaceEvent, so we observe
        // successful right-click placements by checking state/item changes next tick.
        UseBlockCallback.EVENT.register((player, world, hand, hitResult) -> {
            if (!started || world.isClient) return ActionResult.PASS;
            if (!(player instanceof ServerPlayerEntity sp)) return ActionResult.PASS;
            ItemStack stack = sp.getStackInHand(hand);
            if (!(stack.getItem() instanceof BlockItem)) return ActionResult.PASS;

            BlockPos clicked = hitResult.getBlockPos();
            BlockPos placePos = clicked.offset(hitResult.getSide());
            BlockState beforeClicked = world.getBlockState(clicked);
            BlockState beforePlace = world.getBlockState(placePos);
            int countBefore = stack.getCount();

            server.execute(() -> {
                if (!started) return;
                PlayerProfile p = profiles.get(sp.getUuid());
                if (p == null || !p.online) return;
                ItemStack afterStack = sp.getStackInHand(hand);
                BlockState afterClicked = world.getBlockState(clicked);
                BlockState afterPlace = world.getBlockState(placePos);
                boolean changed =
                    !afterPlace.equals(beforePlace)
                        || !afterClicked.equals(beforeClicked)
                        || afterStack.getCount() < countBefore;
                if (!changed) return;
                p.blocksPlaced += 1;
                p.lastActivityMs = System.currentTimeMillis();
                p.dirtyAt = p.lastActivityMs;
            });
            return ActionResult.PASS;
        });

        // Some placements go through item-use path (special block items).
        UseItemCallback.EVENT.register((player, world, hand) -> {
            ItemStack stack = player.getStackInHand(hand);
            if (!started || world.isClient) return TypedActionResult.pass(stack);
            if (!(player instanceof ServerPlayerEntity sp)) return TypedActionResult.pass(stack);
            if (!(stack.getItem() instanceof BlockItem)) return TypedActionResult.pass(stack);
            int countBefore = stack.getCount();
            server.execute(() -> {
                if (!started) return;
                PlayerProfile p = profiles.get(sp.getUuid());
                if (p == null || !p.online) return;
                ItemStack after = sp.getStackInHand(hand);
                if (after.getCount() < countBefore) {
                    p.blocksPlaced += 1;
                    p.lastActivityMs = System.currentTimeMillis();
                    p.dirtyAt = p.lastActivityMs;
                }
            });
            return TypedActionResult.pass(stack);
        });

        ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> {
            if (!started) return;
            PlayerProfile p = profiles.get(sender.getUuid());
            if (p == null) return;
            p.chatMessages += 1;
            p.lastActivityMs = System.currentTimeMillis();
            p.dirtyAt = p.lastActivityMs;
        });

        ServerEntityCombatEvents.AFTER_KILLED_OTHER_ENTITY.register((world, entity, killed) -> {
            if (!started) return;
            if (!(entity instanceof ServerPlayerEntity attacker)) return;
            PlayerProfile ap = profiles.get(attacker.getUuid());
            if (ap == null) return;
            if (killed instanceof PlayerEntity) ap.playerKills += 1;
            else ap.mobKills += 1;
            ap.lastActivityMs = System.currentTimeMillis();
            ap.dirtyAt = ap.lastActivityMs;
        });
    }

    private void onEndTick() {
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
        for (ServerPlayerEntity sp : server.getPlayerManager().getPlayerList()) {
            PlayerProfile p = profiles.get(sp.getUuid());
            if (p == null || !p.online) continue;

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

            String dim = dimId(sp);
            if (p.currentDim == null) {
                p.currentDim = dim;
                p.dimSegmentStartMs = now;
            } else if (!p.currentDim.equals(dim)) {
                accrueDim(p, p.currentDim, now);
                p.currentDim = dim;
                p.dimSegmentStartMs = now;
            }

            double x = sp.getX(), y = sp.getY(), z = sp.getZ();
            if (p.hasPrevPos) {
                double dx = x - p.prevX;
                double dy = y - p.prevY;
                double dz = z - p.prevZ;
                double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist > 0.01 && dist < 50.0) {
                    classifyDistance(p, sp, dist, dy);
                    if (dist > 0.05) {
                        p.lastMoveMs = now;
                        p.lastActivityMs = now;
                    }
                } else if (dist >= 50.0) {
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

            int ping = Math.max(0, getPing(sp));
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

    private void classifyDistance(PlayerProfile p, ServerPlayerEntity sp, double dist, double dy) {
        if (sp.isFallFlying()) {
            p.distanceElytra += dist;
            return;
        }
        if (sp.isSwimming() || sp.isTouchingWater()) {
            p.distanceSwim += dist;
            return;
        }
        Entity vehicle = sp.getVehicle();
        if (vehicle instanceof BoatEntity) {
            p.distanceBoat += dist;
            return;
        }
        if (vehicle instanceof AbstractHorseEntity) {
            p.distanceHorse += dist;
            return;
        }
        if (vehicle instanceof MinecartEntity) {
            p.distanceMinecart += dist;
            return;
        }
        if (!sp.isOnGround() && dy > 0.1 && sp.getVelocity().y > 0.1) {
            p.distanceFlown += dist;
            return;
        }
        if (sp.isSneaking()) {
            p.distanceCrouch += dist;
            return;
        }
        if (sp.isSprinting()) {
            p.distanceSprint += dist;
            return;
        }
        if (!sp.isOnGround() && dy < -0.2) {
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

    private static String dimId(ServerPlayerEntity sp) {
        try {
            return sp.getWorld().getRegistryKey().getValue().toString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private void onJoin(ServerPlayerEntity sp) {
        long now = System.currentTimeMillis();
        PlayerProfile p = profiles.computeIfAbsent(sp.getUuid(),
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

    private void onQuit(ServerPlayerEntity sp, long now) {
        PlayerProfile p = profiles.get(sp.getUuid());
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

    private void onDeath(LivingEntity dead, DamageSource src) {
        long now = System.currentTimeMillis();
        if (dead instanceof ServerPlayerEntity victim) {
            PlayerProfile vp = profiles.get(victim.getUuid());
            if (vp != null) {
                vp.deaths += 1;
                vp.lastActivityMs = now;
                vp.dirtyAt = now;
            }
        }
        Entity killer = src.getAttacker();
        if (killer instanceof ServerPlayerEntity attacker) {
            PlayerProfile ap = profiles.get(attacker.getUuid());
            if (ap != null) {
                if (dead instanceof PlayerEntity) ap.playerKills += 1;
                else ap.mobKills += 1;
                ap.lastActivityMs = now;
                ap.dirtyAt = now;
            }
        }
    }

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
        try {
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

    private void writeLiveJson(boolean stopping) throws IOException {
        long now = System.currentTimeMillis();
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("schema", 2);
        root.put("mod", "mcsm_metrics");
        root.put("modVersion", "0.2.1");
        root.put("loader", "fabric");
        root.put("mc", "1.20.4");
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
        for (ServerPlayerEntity sp : server.getPlayerManager().getPlayerList()) {
            PlayerProfile p = profiles.get(sp.getUuid());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", sp.getGameProfile().getName());
            row.put("uuid", sp.getUuid().toString());
            row.put("pingMs", Math.max(0, getPing(sp)));
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
        root.put("maxPlayers", server.getMaxPlayerCount());
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


    private static int getPing(ServerPlayerEntity sp) {
        try {
            if (sp.networkHandler != null) {
                return Math.max(0, sp.networkHandler.getLatency());
            }
        } catch (Throwable ignored) {
        }
        return 0;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
