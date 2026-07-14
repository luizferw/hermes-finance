"use client";

import { Area, AreaChart, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatMoney } from "@kosh/domain";
import { formatDateShort } from "@/lib/format";

const config = {
  netWorthMinor: { label: "Net worth", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * The trend, woven under the figure — not boxed. A bare fern area that bleeds
 * the full width of the position band: no grid, no axes, no labels. It exists
 * to give the net-worth number a felt direction, nothing more. Hovering
 * surfaces a single read-out so the line stays interactive without ever
 * competing with the headline figure. Built on the shared ChartContainer so it
 * sizes reliably inside the grid track.
 */
export function NetWorthSpark({
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
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="nwSparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        {/* Tight domain with headroom so the trajectory uses the band's full
            height instead of flattening against an auto scale that includes 0. */}
        <YAxis hide domain={["dataMin", "dataMax"]} padding={{ top: 6, bottom: 2 }} />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              // No XAxis, so the tooltip's `label` is the series name, not a
              // date — read the date off the hovered point's payload instead.
              labelFormatter={(_label, p) => {
                const d = p?.[0]?.payload?.date;
                return d ? formatDateShort(String(d)) : "";
              }}
              formatter={(value) => formatMoney(Number(value), currencyCode)}
            />
          }
        />
        <Area
          dataKey="netWorthMinor"
          type="monotone"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#nwSparkFill)"
          dot={false}
          activeDot={{
            r: 3,
            fill: "var(--chart-1)",
            stroke: "var(--background)",
            strokeWidth: 2,
          }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
