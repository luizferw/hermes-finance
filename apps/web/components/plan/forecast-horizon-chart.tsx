"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDate, formatDateShort, formatMoney } from "@/lib/format";

export interface HorizonSeries {
  horizonDays: number;
  label: string;
  data: Array<{ date: string; closingBalanceMinor: number }>;
  /** Every figure below comes straight from the forecast engine for this exact horizon. */
  openingBalanceMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
}

const config = {
  closingBalanceMinor: { label: "Balance", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * Daily balance trajectory with a horizon switch. Each horizon is a fully
 * separate engine run — switching never recomputes anything client-side, it
 * only changes which precomputed series is shown. The lowest point in the
 * window is always marked, since that's the number that actually matters:
 * whether the plan holds.
 */
export function ForecastHorizonChart({
  series,
  currency,
  defaultHorizonDays = 90,
}: {
  series: HorizonSeries[];
  currency: string;
  defaultHorizonDays?: number;
}) {
  const defaultIndex = Math.max(
    0,
    series.findIndex((s) => s.horizonDays === defaultHorizonDays),
  );
  const [index, setIndex] = useState(defaultIndex);
  const active = series[index] ?? series[0];
  if (!active) return null;

  const minPoint = active.data.find((d) => d.date === active.minimumBalanceDate);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="micro-label">Balance trajectory</span>
        <ToggleGroup
          type="single"
          size="sm"
          value={String(index)}
          onValueChange={(v) => {
            if (v) setIndex(Number(v));
          }}
          aria-label="Forecast horizon"
        >
          {series.map((s, i) => (
            <ToggleGroupItem key={s.horizonDays} value={String(i)} className="text-xs">
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ChartContainer config={config} className="mt-4 aspect-auto h-56 w-full">
        <AreaChart data={active.data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
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
                formatter={(value) => (
                  <span className="font-amount">{formatMoney(Number(value), currency)}</span>
                )}
              />
            }
          />
          <Area
            dataKey="closingBalanceMinor"
            type="monotone"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#forecastFill)"
            dot={false}
          />
          {minPoint && (
            <ReferenceDot
              x={minPoint.date}
              y={minPoint.closingBalanceMinor}
              r={4}
              fill="var(--destructive)"
              stroke="var(--background)"
              strokeWidth={2}
              ifOverflow="extendDomain"
            />
          )}
        </AreaChart>
      </ChartContainer>

      <p className="mt-2 text-xs text-muted-foreground">
        Lowest point: <span className="font-amount tabular-nums">{formatMoney(active.minimumBalanceMinor, currency)}</span> on{" "}
        {formatDate(active.minimumBalanceDate)}.
      </p>

      {/* Textual alternative to the chart, for anyone who can't read the plot. */}
      <p className="sr-only">
        Over the next {active.label}, the balance is projected to start at{" "}
        {formatMoney(active.openingBalanceMinor, currency)} and fall to a low of{" "}
        {formatMoney(active.minimumBalanceMinor, currency)} on {formatDate(active.minimumBalanceDate)}.
      </p>
    </div>
  );
}
