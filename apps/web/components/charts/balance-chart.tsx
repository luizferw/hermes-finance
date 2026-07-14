"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatMoney } from "@kosh/domain";
import { formatDateShort } from "@/lib/format";

const config = {
  balanceMinor: { label: "Balance", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** Single-account balance trend. */
export function BalanceChart({
  data,
  currencyCode,
  className,
}: {
  data: Array<{ date: string; balanceMinor: number }>;
  currencyCode: string;
  className?: string;
}) {
  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <defs>
          <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
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
              formatter={(value) => (
                <span className="font-amount">
                  {formatMoney(Number(value), currencyCode)}
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="balanceMinor"
          type="monotone"
          stroke="var(--chart-2)"
          strokeWidth={2}
          fill="url(#balanceFill)"
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}
