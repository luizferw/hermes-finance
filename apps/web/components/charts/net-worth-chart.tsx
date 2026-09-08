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
  netWorthMinor: { label: "Net worth", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** Chart data stays in minor units; formatting happens at the edges. */
export function NetWorthChart({
  data,
  currencyCode,
  className,
}: {
  data: Array<{ date: string; netWorthMinor: number }>;
  currencyCode: string;
  className?: string;
}) {
  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <defs>
          <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
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
          dataKey="netWorthMinor"
          type="monotone"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#netWorthFill)"
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
