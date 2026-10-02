"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDate, formatDateShort, formatMoney } from "@/lib/format";

export interface HorizonMovement {
  id: string;
  label: string;
  /** Signed cash impact, as the engine projected it. */
  amountMinor: number;
}

export interface HorizonPoint {
  date: string;
  closingBalanceMinor: number;
  /** The projected events that land on this day. */
  movements: HorizonMovement[];
}

export interface HorizonSeries {
  horizonDays: number;
  label: string;
  data: HorizonPoint[];
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
          <ChartTooltip content={<HorizonTooltip currency={currency} />} />
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

/**
 * The day's closing balance plus the movements that produced it. Recharts
 * injects `active` and `payload`; the point itself rides on the payload, so
 * the list is whatever the engine put on that day.
 */
function HorizonTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: HorizonPoint }>;
  currency: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs/relaxed shadow-xl">
      <div className="font-medium">{formatDateShort(point.date)}</div>
      <div className="font-amount tabular-nums">{formatMoney(point.closingBalanceMinor, currency)}</div>
      {point.movements.length > 0 ? (
        <ul className="grid gap-1 border-t border-border/50 pt-1.5">
          {point.movements.map((movement) => (
            <li key={movement.id} className="flex items-baseline justify-between gap-4">
              <span className="max-w-40 truncate text-muted-foreground">{movement.label}</span>
              <span
                className={
                  movement.amountMinor < 0
                    ? "font-amount text-destructive tabular-nums"
                    : "font-amount text-success tabular-nums"
                }
              >
                {formatMoney(movement.amountMinor, currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-t border-border/50 pt-1.5 text-muted-foreground">No movements this day</div>
      )}
    </div>
  );
}
