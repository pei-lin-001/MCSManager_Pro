import { t } from "@/lang/i18n";

export const ALL_DAEMON_MODE = "global";

export const GLOBAL_INSTANCE_NAME = "__MCSM_GLOBAL_INSTANCE__";

export const GLOBAL_INSTANCE_UUID = "global0001";

export const PERMISSION_MAP: Record<string, string> = {
  "1": t("TXT_CODE_ROLE_USER"),
  "5": t("TXT_CODE_ROLE_MANAGER"),
  "10": t("TXT_CODE_ROLE_SUPER_ADMIN"),
  "-1": t("TXT_CODE_7c76dbf")
};
