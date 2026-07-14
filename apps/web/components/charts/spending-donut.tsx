"use client";

import { Cell, Pie, PieChart } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatMoney } from "@kosh/domain";

const FALLBACK_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export interface DonutSlice {
  name: string;
  spentMinor: number;
  color: string | null;
}

const config = { spentMinor: { label: "Spent" } } satisfies ChartConfig;

/** Top-N categories + "Other", rendered as a donut. */
export function SpendingDonut({
  data,
  currencyCode,
  className,
  topN = 6,
}: {
  data: DonutSlice[];
  currencyCode: string;
  className?: string;
  topN?: number;
}) {
  const top = data.slice(0, topN);
  const rest = data.slice(topN);
  const slices = [...top];
  if (rest.length > 0) {
    slices.push({
      name: "Other",
      spentMinor: rest.reduce((acc, s) => acc + s.spentMinor, 0),
      color: "var(--muted-foreground)",
    });
  }

  return (
    <ChartContainer
      config={config}
      className={className ?? "mx-auto aspect-square max-h-56"}
    >
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, _name, item) => (
                <div className="flex w-full items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="size-2 rounded-[2px]"
                      style={{ background: item?.payload?.fill }}
                    />
                    {item?.payload?.name}
                  </span>
                  <span className="font-amount">
                    {formatMoney(Number(value), currencyCode)}
                  </span>
                </div>
              )}
            />
          }
        />
        <Pie
          data={slices}
          dataKey="spentMinor"
          nameKey="name"
          innerRadius="62%"
          outerRadius="92%"
          paddingAngle={2}
          strokeWidth={0}
        >
          {slices.map((slice, index) => (
            <Cell
              key={slice.name}
              fill={slice.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]}
            />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}
