import { useDefineApi } from "@/stores/useDefineApi";
import type { OperationLoggerItem } from "@/types/operationLog";

export const getOperationLog = useDefineApi<
  {
    params?: {
      limit?: number;
    };
  },
  OperationLoggerItem[]
>({
  url: "/api/overview/operation_logs",
  method: "GET"
});
