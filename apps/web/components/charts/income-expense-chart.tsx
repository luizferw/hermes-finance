"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatMoney } from "@kosh/domain";
import { formatMonth } from "@/lib/format";

const config = {
  incomeMinor: { label: "Income", color: "var(--chart-1)" },
  expenseMinor: { label: "Expenses", color: "var(--chart-5)" },
} satisfies ChartConfig;

export function IncomeExpenseChart({
  data,
  currencyCode,
  className,
}: {
  data: Array<{ month: string; incomeMinor: number; expenseMinor: number }>;
  currencyCode: string;
  className?: string;
}) {
  return (
    <ChartContainer config={config} className={className}>
      <BarChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: string) => formatMonth(v)}
        />
        <YAxis hide />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => formatMonth(String(v))}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="size-2 rounded-[2px]"
                      style={{ background: item?.color }}
                    />
                    {name === "incomeMinor" ? "Income" : "Expenses"}
                  </span>
                  <span className="font-amount">
                    {formatMoney(Number(value), currencyCode)}
                  </span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="incomeMinor" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="expenseMinor" fill="var(--chart-5)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
