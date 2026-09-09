"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDateShort, formatMoney } from "@/lib/format";

const config = {
  beforeMinor: { label: "Without this purchase", color: "var(--chart-3)" },
  afterMinor: { label: "With this purchase", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * Overlays the baseline forecast against the forecast the engine produced
 * after folding the simulated purchase in. Both series come straight from
 * `Forecast.days[].closingBalanceMinor` runs — nothing here recomputes a
 * balance, it only merges two already-decided series by date for display.
 */
export function SimulationBalanceChart({
  data,
  currencyCode,
}: {
  data: Array<{ date: string; beforeMinor: number; afterMinor: number }>;
  currencyCode: string;
}) {
  return (
    <ChartContainer config={config}>
      <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <defs>
          <linearGradient id="simulationAfterFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tickFormatter={(v: string) => formatDateShort(v)}
        />
        <YAxis hide domain={["auto", "auto"]} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => formatDateShort(String(v))}
              formatter={(value) => formatMoney(Number(value), currencyCode)}
            />
          }
        />
        <Area
          dataKey="beforeMinor"
          type="monotone"
          stroke="var(--chart-3)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          fill="none"
          dot={false}
        />
        <Area
          dataKey="afterMinor"
          type="monotone"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#simulationAfterFill)"
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
