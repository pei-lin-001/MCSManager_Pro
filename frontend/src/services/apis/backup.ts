import { useDefineApi } from "@/stores/useDefineApi";

export type BackupScope = "world" | "core" | "full";

export interface BackupRecord {
  id: string;
  instanceUuid: string;
  nickname?: string;
  scope: BackupScope;
  createdAt: number;
  sizeBytes: number;
  status: "queued" | "running" | "done" | "failed";
  fileName: string;
  note?: string;
  trigger: "manual" | "schedule" | "pre-restore";
  serverWasRunning: boolean;
  error?: string;
  protected?: boolean;
}

export interface BackupListResponse {
  keepCount: number;
  items: BackupRecord[];
}

export const listBackups = useDefineApi<
  { params: { daemonId: string; uuid: string } },
  BackupListResponse
>({
  url: "/api/protected_instance/backup/list",
  method: "GET"
});

export const getBackupSettings = useDefineApi<
  { params: { daemonId: string; uuid: string } },
  { keepCount: number; defaultKeepCount: number; min: number; max: number }
>({
  url: "/api/protected_instance/backup/settings",
  method: "GET"
});

export const setBackupSettings = useDefineApi<
  {
    params: { daemonId: string; uuid: string };
    data: { keepCount: number };
  },
  { keepCount: number }
>({
  url: "/api/protected_instance/backup/settings",
  method: "PUT"
});

export const createBackup = useDefineApi<
  {
    params: { daemonId: string; uuid: string };
    data: { scope?: BackupScope; note?: string };
  },
  BackupRecord
>({
  url: "/api/protected_instance/backup/create",
  method: "POST"
});

export const deleteBackup = useDefineApi<
  { params: { daemonId: string; uuid: string; backupId: string } },
  boolean
>({
  url: "/api/protected_instance/backup/",
  method: "DELETE"
});

export const restoreBackup = useDefineApi<
  {
    params: { daemonId: string; uuid: string };
    data: { backupId: string; autoStart?: boolean; skipPreBackup?: boolean };
  },
  { ok: boolean; restored: number; backupId: string }
>({
  url: "/api/protected_instance/backup/restore",
  method: "POST"
});
