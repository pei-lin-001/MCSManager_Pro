# MCSM Metrics multi-version packs

Companion metrics mod for MCSManager player monitor / TPS.

## Output

See `dist/`:

| Pack | Loader | MC | Jar |
|------|--------|----|-----|
| forge-1.20.1 | Forge | 1.20.1 | `dist/forge-1.20.1/mcsm_metrics-forge-1.20.1-0.2.0.jar` |
| fabric-1.20.1 | Fabric | 1.20.1 | `dist/fabric-1.20.1/mcsm_metrics-fabric-1.20.1-0.2.2.jar` |
| fabric-1.20.4 | Fabric | 1.20.4 | `dist/fabric-1.20.4/mcsm_metrics-fabric-1.20.4-0.2.1.jar` |
| fabric-1.21.1 | Fabric | 1.21.1 | `dist/fabric-1.21.1/mcsm_metrics-fabric-1.21.1-0.2.1.jar` |

`dist/manifest.json` indexes packs for future panel auto-inject.

## Runtime contract

All packs write the same schema:

- `mcsm-metrics.json` (live, ~2s)
- `mcsm-metrics/players/<uuid>.json` (profiles)

Fields used by panel:

- performance.tps / mspt
- playersOnline (+ ping/afk/session stats)
- rankings
- profile.mobKillsByType (entity id -> count, schema via metrics 0.2.2+)

## Build

### Forge 1.20.1

Existing project under `/tmp/mcsm-metrics-mod` (or copy into `forge-1.20.1` later).

```bash
cd /tmp/mcsm-metrics-mod
./gradlew build
```

### Fabric 1.20.1 (Java 17)

```bash
cd fabric-1.20.1
./gradlew build
```

### Fabric 1.21.1 (Java 21)

```bash
export JAVA_HOME=/path/to/jdk-21
cd fabric-1.21.1
./gradlew build
```

## Install manually

- Forge/Fabric: put jar into instance `mods/`
- Restart the game server
- Confirm `mcsm-metrics.json` appears in instance root

## Next (not done yet)

1. Forge/NeoForge 1.21.x packs
2. Panel auto-inject after precise install / market install
3. Paper plugin variant (optional)

## Notes

- Fabric 1.20.1/1.21.1 ports keep the same JSON schema as Forge.
- Some Fabric events are thinner than Forge (e.g. place/craft/xp may be partial).
- Do not mix loader jars (Forge jar will not load on Fabric and vice versa).
