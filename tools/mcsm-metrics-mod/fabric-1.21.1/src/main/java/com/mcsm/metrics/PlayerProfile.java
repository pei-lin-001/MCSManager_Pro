package com.mcsm.metrics;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Persistent + session stats for one player.
 * All counters are cumulative across sessions unless named session*.
 */
public class PlayerProfile {
    public String uuid;
    public String name;

    public long firstJoin;
    public long lastJoin;
    public long lastQuit;
    public long joinCount;

    public long totalPlayMs;
    public long totalActiveMs;
    public long totalAfkMs;

    public long deaths;
    public long playerKills;
    public long mobKills;
    /** entity type id -> kill count, e.g. minecraft:zombie */
    public Map<String, Long> mobKillsByType = new HashMap<>();

    public long damageDealt;
    public long damageTaken;

    public long blocksBroken;
    public long blocksPlaced;

    public long itemsCrafted;
    public long itemsPicked;

    public long chatMessages;
    public long commandsUsed;
    public long xpGained;

    public double distanceWalked;
    public double distanceFlown;
    public double distanceElytra;
    public double distanceBoat;
    public double distanceHorse;
    public double distanceMinecart;
    public double distanceSwim;
    public double distanceSprint;
    public double distanceCrouch;
    public double distanceFall;

    /** Dimension id -> ms */
    public Map<String, Long> dimensionTimeMs = new HashMap<>();

    public String lastDim;
    public double lastX;
    public double lastY;
    public double lastZ;

    public long lastPingSum;
    public long lastPingSamples;
    public int lastPingMax;

    // --- runtime only (not all need persistence of transient fields) ---
    public transient long sessionStartMs;
    public transient long sessionPlayMs;
    public transient long sessionActiveMs;
    public transient long sessionAfkMs;
    public transient boolean online;
    public transient boolean afk;
    public transient long lastMoveMs;
    public transient long lastActivityMs;
    public transient String currentDim;
    public transient double prevX, prevY, prevZ;
    public transient boolean hasPrevPos;
    public transient long dimSegmentStartMs;
    public transient long dirtyAt;
    public transient int pingSumSession;
    public transient int pingSamplesSession;
    public transient int pingMaxSession;

    public static PlayerProfile create(UUID id, String name, long now) {
        PlayerProfile p = new PlayerProfile();
        p.uuid = id.toString();
        p.name = name;
        p.firstJoin = now;
        p.lastJoin = now;
        p.joinCount = 0;
        return p;
    }

    public double avgPing() {
        if (lastPingSamples <= 0) return 0;
        return (double) lastPingSum / (double) lastPingSamples;
    }

    public long totalDistanceRounded() {
        double t = distanceWalked + distanceFlown + distanceElytra + distanceBoat
            + distanceHorse + distanceMinecart + distanceSwim + distanceSprint
            + distanceCrouch + distanceFall;
        return Math.round(t);
    }
}
