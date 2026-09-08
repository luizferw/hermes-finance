"use client";

import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis, Cell } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDateShort, formatMoney } from "@/lib/format";

const config = {
  netMinor: { label: "Net" },
} satisfies ChartConfig;

/** Daily net cashflow: green above zero, rose below. */
export function CashflowChart({
  data,
  currencyCode,
  className,
}: {
  data: Array<{ date: string; netMinor: number }>;
  currencyCode: string;
  className?: string;
}) {
  return (
    <ChartContainer config={config} className={className}>
      <BarChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tickFormatter={(v: string) => formatDateShort(v)}
        />
        <YAxis hide />
        <ReferenceLine y={0} stroke="var(--border)" />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => formatDateShort(String(v))}
              formatter={(value) => (
                <span className="font-amount">
                  {formatMoney(Number(value), currencyCode, {
                    signDisplay: "exceptZero",
                  })}
                </span>
              )}
            />
          }
        />
        <Bar dataKey="netMinor" radius={[3, 3, 0, 0]} maxBarSize={14}>
          {data.map((point) => (
            <Cell
              key={point.date}
              fill={point.netMinor >= 0 ? "var(--chart-1)" : "var(--chart-5)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
