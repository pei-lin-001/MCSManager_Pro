/**
 * Minecraft console quick-command catalog.
 *
 * Design goals:
 * - Data-driven: add items here without touching Terminal UI structure.
 * - Safe defaults: destructive actions require confirm in the UI.
 * - Server-console oriented: prefer @a / gamerule / weather / difficulty.
 * - No invented runtime state: gamerules are explicit ON/OFF, not toggles that guess current value.
 */

export type McQuickCommandGroupId =
  | "time"
  | "weather"
  | "difficulty"
  | "gamemode"
  | "gamerule"
  | "world"
  | "custom";

export interface McQuickCommandItem {
  id: string;
  /** i18n key for button label */
  labelKey: string;
  /** Fallback label if i18n missing */
  label: string;
  /** Console command (no leading slash) */
  command: string;
  /** Optional tooltip / full description */
  tipKey?: string;
  tip?: string;
  /** Require confirm dialog before send */
  confirm?: boolean;
  /** Danger styling */
  danger?: boolean;
}

export interface McQuickCommandGroup {
  id: McQuickCommandGroupId;
  labelKey: string;
  label: string;
  items: McQuickCommandItem[];
}

export const MC_QUICK_COMMAND_GROUPS: McQuickCommandGroup[] = [
  {
    id: "time",
    labelKey: "TXT_CODE_MC_QC_GROUP_TIME",
    label: "Time",
    items: [
      {
        id: "time-day",
        labelKey: "TXT_CODE_MC_QC_DAY",
        label: "Day",
        command: "time set day",
        tip: "time set day"
      },
      {
        id: "time-noon",
        labelKey: "TXT_CODE_MC_QC_NOON",
        label: "Noon",
        command: "time set noon",
        tip: "time set noon"
      },
      {
        id: "time-night",
        labelKey: "TXT_CODE_MC_QC_NIGHT",
        label: "Night",
        command: "time set night",
        tip: "time set night"
      },
      {
        id: "time-midnight",
        labelKey: "TXT_CODE_MC_QC_MIDNIGHT",
        label: "Midnight",
        command: "time set midnight",
        tip: "time set midnight"
      }
    ]
  },
  {
    id: "weather",
    labelKey: "TXT_CODE_MC_QC_GROUP_WEATHER",
    label: "Weather",
    items: [
      {
        id: "weather-clear",
        labelKey: "TXT_CODE_MC_QC_WEATHER_CLEAR",
        label: "Clear",
        command: "weather clear",
        tip: "weather clear"
      },
      {
        id: "weather-rain",
        labelKey: "TXT_CODE_MC_QC_WEATHER_RAIN",
        label: "Rain",
        command: "weather rain",
        tip: "weather rain"
      },
      {
        id: "weather-thunder",
        labelKey: "TXT_CODE_MC_QC_WEATHER_THUNDER",
        label: "Thunder",
        command: "weather thunder",
        tip: "weather thunder"
      }
    ]
  },
  {
    id: "difficulty",
    labelKey: "TXT_CODE_MC_QC_GROUP_DIFFICULTY",
    label: "Difficulty",
    items: [
      {
        id: "diff-peaceful",
        labelKey: "TXT_CODE_MC_QC_DIFF_PEACEFUL",
        label: "Peaceful",
        command: "difficulty peaceful"
      },
      {
        id: "diff-easy",
        labelKey: "TXT_CODE_MC_QC_DIFF_EASY",
        label: "Easy",
        command: "difficulty easy"
      },
      {
        id: "diff-normal",
        labelKey: "TXT_CODE_MC_QC_DIFF_NORMAL",
        label: "Normal",
        command: "difficulty normal"
      },
      {
        id: "diff-hard",
        labelKey: "TXT_CODE_MC_QC_DIFF_HARD",
        label: "Hard",
        command: "difficulty hard",
        confirm: true
      }
    ]
  },
  {
    id: "gamemode",
    labelKey: "TXT_CODE_MC_QC_GROUP_GAMEMODE",
    label: "Mode (all)",
    items: [
      {
        id: "gm-survival",
        labelKey: "TXT_CODE_MC_QC_GM_SURVIVAL",
        label: "Survival",
        command: "gamemode survival @a",
        confirm: true,
        tip: "gamemode survival @a"
      },
      {
        id: "gm-creative",
        labelKey: "TXT_CODE_MC_QC_GM_CREATIVE",
        label: "Creative",
        command: "gamemode creative @a",
        confirm: true,
        tip: "gamemode creative @a"
      },
      {
        id: "gm-adventure",
        labelKey: "TXT_CODE_MC_QC_GM_ADVENTURE",
        label: "Adventure",
        command: "gamemode adventure @a",
        confirm: true,
        tip: "gamemode adventure @a"
      },
      {
        id: "gm-spectator",
        labelKey: "TXT_CODE_MC_QC_GM_SPECTATOR",
        label: "Spectator",
        command: "gamemode spectator @a",
        confirm: true,
        tip: "gamemode spectator @a"
      }
    ]
  },
  {
    id: "gamerule",
    labelKey: "TXT_CODE_MC_QC_GROUP_GAMERULE",
    label: "Rules",
    items: [
      {
        id: "keepinv-on",
        labelKey: "TXT_CODE_MC_QC_KEEPINV_ON",
        label: "KeepInv ON",
        command: "gamerule keepInventory true",
        tip: "Death keep inventory"
      },
      {
        id: "keepinv-off",
        labelKey: "TXT_CODE_MC_QC_KEEPINV_OFF",
        label: "KeepInv OFF",
        command: "gamerule keepInventory false",
        confirm: true
      },
      {
        id: "daycycle-on",
        labelKey: "TXT_CODE_MC_QC_DAYCYCLE_ON",
        label: "DayCycle ON",
        command: "gamerule doDaylightCycle true"
      },
      {
        id: "daycycle-off",
        labelKey: "TXT_CODE_MC_QC_DAYCYCLE_OFF",
        label: "DayCycle OFF",
        command: "gamerule doDaylightCycle false"
      },
      {
        id: "weathercycle-on",
        labelKey: "TXT_CODE_MC_QC_WEATHERCYCLE_ON",
        label: "WeatherCycle ON",
        command: "gamerule doWeatherCycle true"
      },
      {
        id: "weathercycle-off",
        labelKey: "TXT_CODE_MC_QC_WEATHERCYCLE_OFF",
        label: "WeatherCycle OFF",
        command: "gamerule doWeatherCycle false"
      },
      {
        id: "mobspawn-on",
        labelKey: "TXT_CODE_MC_QC_MOBSPAWN_ON",
        label: "MobSpawn ON",
        command: "gamerule doMobSpawning true"
      },
      {
        id: "mobspawn-off",
        labelKey: "TXT_CODE_MC_QC_MOBSPAWN_OFF",
        label: "MobSpawn OFF",
        command: "gamerule doMobSpawning false"
      },
      {
        id: "mobgrief-on",
        labelKey: "TXT_CODE_MC_QC_MOBGRIEF_ON",
        label: "MobGrief ON",
        command: "gamerule mobGriefing true"
      },
      {
        id: "mobgrief-off",
        labelKey: "TXT_CODE_MC_QC_MOBGRIEF_OFF",
        label: "MobGrief OFF",
        command: "gamerule mobGriefing false"
      },
      {
        id: "firetick-on",
        labelKey: "TXT_CODE_MC_QC_FIRETICK_ON",
        label: "FireTick ON",
        command: "gamerule doFireTick true"
      },
      {
        id: "firetick-off",
        labelKey: "TXT_CODE_MC_QC_FIRETICK_OFF",
        label: "FireTick OFF",
        command: "gamerule doFireTick false"
      },
      {
        id: "regen-on",
        labelKey: "TXT_CODE_MC_QC_REGEN_ON",
        label: "Regen ON",
        command: "gamerule naturalRegeneration true"
      },
      {
        id: "regen-off",
        labelKey: "TXT_CODE_MC_QC_REGEN_OFF",
        label: "Regen OFF",
        command: "gamerule naturalRegeneration false"
      },
      {
        id: "adv-on",
        labelKey: "TXT_CODE_MC_QC_ADV_ON",
        label: "AdvMsg ON",
        command: "gamerule announceAdvancements true"
      },
      {
        id: "adv-off",
        labelKey: "TXT_CODE_MC_QC_ADV_OFF",
        label: "AdvMsg OFF",
        command: "gamerule announceAdvancements false"
      }
    ]
  },
  {
    id: "world",
    labelKey: "TXT_CODE_MC_QC_GROUP_WORLD",
    label: "World",
    items: [
      {
        id: "list",
        labelKey: "TXT_CODE_MC_QC_LIST",
        label: "List",
        command: "list"
      },
      {
        id: "seed",
        labelKey: "TXT_CODE_MC_QC_SEED",
        label: "Seed",
        command: "seed"
      },
      {
        id: "save-all",
        labelKey: "TXT_CODE_MC_QC_SAVE",
        label: "Save",
        command: "save-all"
      },
      {
        id: "whitelist-on",
        labelKey: "TXT_CODE_MC_QC_WHITELIST_ON",
        label: "Whitelist ON",
        command: "whitelist on",
        confirm: true
      },
      {
        id: "whitelist-off",
        labelKey: "TXT_CODE_MC_QC_WHITELIST_OFF",
        label: "Whitelist OFF",
        command: "whitelist off",
        confirm: true
      },
      {
        id: "clear-items",
        labelKey: "TXT_CODE_MC_QC_CLEAR_ITEMS",
        label: "Clear drops",
        command: "kill @e[type=item]",
        confirm: true,
        danger: true,
        tip: "kill @e[type=item]"
      },
      {
        id: "kill-mobs",
        labelKey: "TXT_CODE_MC_QC_KILL_MOBS",
        label: "Kill mobs",
        command: "kill @e[type=!player,type=!item]",
        confirm: true,
        danger: true,
        tip: "kill non-player non-item entities"
      }
    ]
  }
];

export const MC_QUICK_CUSTOM_STORAGE_KEY = "mcsm.mcQuickCommands.custom.v1";

export interface McCustomQuickCommand {
  id: string;
  label: string;
  command: string;
  confirm?: boolean;
}

export function loadCustomQuickCommands(): McCustomQuickCommand[] {
  try {
    const raw = localStorage.getItem(MC_QUICK_CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.command === "string" && typeof x.label === "string")
      .map((x) => ({
        id: String(x.id || `custom-${Date.now()}`),
        label: String(x.label).slice(0, 32),
        command: String(x.command).trim().replace(/^\//, ""),
        confirm: !!x.confirm
      }))
      .filter((x) => x.command.length > 0);
  } catch {
    return [];
  }
}

export function saveCustomQuickCommands(list: McCustomQuickCommand[]) {
  localStorage.setItem(MC_QUICK_CUSTOM_STORAGE_KEY, JSON.stringify(list.slice(0, 40)));
}

export function isMinecraftJavaType(type?: string | null): boolean {
  const t = String(type || "").toLowerCase();
  return t.startsWith("minecraft/java") || t === "minecraft/java" || t.includes("minecraft/java");
}
