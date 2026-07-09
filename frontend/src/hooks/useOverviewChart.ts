import { init, graphic, type ECharts } from "echarts";
import { onMounted, onUnmounted, ref } from "vue";

export function useSimpleChart(dom: string) {
  let chart = ref<ECharts>();

  onMounted(() => {
    chart.value = init(document.getElementById(dom));
    chart.value.setOption(getSimpleChartDefaultOption());
  });

  onUnmounted(() => {
    chart.value?.dispose();
    chart.value = undefined;
  });

  return {
    instance: chart,
    setOption: (v: any) => chart.value?.setOption(v)
  };
}

export function useOverviewChart(dom: string) {
  let chart = ref<ECharts>();
  let resizeObserver: ResizeObserver | undefined;

  const resize = () => {
    chart.value?.resize();
  };

  onMounted(() => {
    const el = document.getElementById(dom);
    if (!el) return;
    chart.value = init(el);
    chart.value.setOption(getChartDefaultOption());

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(el);
    } else {
      window.addEventListener("resize", resize);
    }
  });

  onUnmounted(() => {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    window.removeEventListener("resize", resize);
    chart.value?.dispose();
    chart.value = undefined;
  });

  return {
    instance: chart,
    setOption: (v: Record<string, unknown>) => {
      chart.value?.setOption(v);
      // Ensure canvas fits the latest card box after data updates.
      requestAnimationFrame(() => chart.value?.resize());
    }
  };
}

function getChartDefaultOption() {
  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(20, 24, 35, 0.9)",
      borderColor: "rgba(67, 145, 250, 0.28)",
      borderWidth: 1,
      padding: [8, 12],
      textStyle: {
        color: "#e8eef8",
        fontSize: 12
      },
      axisPointer: {
        type: "line",
        lineStyle: {
          color: "rgba(67, 145, 250, 0.45)",
          width: 1,
          type: "dashed"
        }
      },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list[0] as {
          data?: unknown;
          value?: unknown;
          axisValue?: unknown;
        };
        const data = p.data;
        let val: unknown = p.value;
        let xVal: unknown = p.axisValue;
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const row = data as Record<string, unknown>;
          val = row.value ?? row.runningInstance ?? val;
          xVal = row.time ?? xVal;
        } else if (Array.isArray(p.value)) {
          val = p.value[1];
        }
        const num = Number(val);
        const displayVal = Number.isFinite(num)
          ? Number.isInteger(num)
            ? num
            : num.toFixed(1)
          : String(val ?? "--");
        return `<span style="color:#94b8e0;font-size:11px">${xVal}</span><br/><span style="font-weight:700;font-size:14px">${displayVal}</span>`;
      }
    },
    grid: {
      show: false,
      borderWidth: 0,
      top: 12,
      bottom: 28,
      left: 36,
      right: 12
    },
    xAxis: {
      type: "category",
      show: true,
      boundaryGap: false,
      axisLabel: {
        fontSize: 10,
        color: "rgba(120, 130, 150, 0.9)",
        margin: 8
      },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      show: true,
      minInterval: 1,
      axisLabel: {
        formatter: "{value}",
        fontSize: 10,
        color: "rgba(120, 130, 150, 0.9)",
        margin: 6
      },
      splitLine: {
        show: true,
        lineStyle: {
          color: "rgba(120, 140, 170, 0.16)",
          type: "dashed",
          width: 1
        }
      },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [
      {
        type: "line",
        smooth: 0.45,
        showSymbol: false,
        lineStyle: {
          color: "rgba(59, 130, 246, 0.95)",
          width: 2.2,
          shadowColor: "rgba(59, 130, 246, 0.28)",
          shadowBlur: 6
        },
        areaStyle: {
          color: new graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(59, 130, 246, 0.42)" },
            { offset: 0.65, color: "rgba(59, 130, 246, 0.1)" },
            { offset: 1, color: "rgba(59, 130, 246, 0)" }
          ])
        }
      }
    ]
  };
}

function getSimpleChartDefaultOption() {
  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(20, 24, 35, 0.85)",
      borderColor: "rgba(67, 145, 250, 0.3)",
      borderWidth: 1,
      padding: [6, 10],
      textStyle: {
        color: "#e0e6f0",
        fontSize: 12
      },
      axisPointer: {
        type: "line",
        lineStyle: {
          color: "rgba(67, 145, 250, 0.5)",
          width: 1,
          type: "dashed"
        }
      },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        const data = p.data;
        const val =
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? data.value
            : Array.isArray(p.value)
              ? p.value[1]
              : p.value;
        const xVal =
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? data.time
            : p.axisValue;
        return `<span style="color:#94b8e0;font-size:11px">#${xVal}</span><br/><span style="font-weight:600;font-size:13px">${Number(val).toFixed(1)}<span style="font-size:11px;font-weight:400;margin-left:1px">%</span></span>`;
      }
    },
    grid: {
      show: false,
      borderWidth: 0,
      top: 6,
      bottom: 4,
      left: 34,
      right: 6
    },
    xAxis: { type: "category", show: false },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      show: true,
      interval: 50,
      axisLabel: {
        formatter: "{value}%",
        fontSize: 10,
        color: "rgba(160, 180, 210, 0.7)",
        margin: 4
      },
      splitLine: {
        show: true,
        lineStyle: {
          color: "rgba(100, 130, 180, 0.12)",
          type: "dashed",
          width: 1
        }
      },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [
      {
        type: "line",
        smooth: 0.6,
        smoothMonotone: "x",
        showSymbol: false,
        lineStyle: {
          color: "rgba(67, 145, 250, 0.95)",
          width: 1.5,
          shadowColor: "rgba(67, 145, 250, 0.3)",
          shadowBlur: 4
        },
        areaStyle: {
          color: new graphic.LinearGradient(0, 0, 0, 1, [
            {
              offset: 0,
              color: "rgba(67, 145, 250, 0.55)"
            },
            {
              offset: 0.6,
              color: "rgba(40, 100, 210, 0.15)"
            },
            {
              offset: 1,
              color: "rgba(17, 60, 150, 0)"
            }
          ])
        }
      }
    ]
  };
}
