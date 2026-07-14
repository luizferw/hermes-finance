import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown, safeMarkdownUrl } from "@/components/ask/assistant-markdown";
import { AgentBlocks } from "@/components/home/agent-blocks";

describe("assistant markdown", () => {
  it("renders headings, lists, tables, and code as readable elements", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>{`# Summary

- Food
- Travel

| Category | Spend |
| --- | ---: |
| Food | ₹1,200 |

Use \`INR\` for this total.`}</AssistantMarkdown>,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain("<code");
  });

  it("drops raw HTML and unsafe links", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>{`<script>alert('x')</script>

[unsafe](javascript:alert('x')) [safe](https://example.com)`}</AssistantMarkdown>,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(safeMarkdownUrl("data:text/html,bad")).toBe("");
  });

  it("keeps long responses bounded and breakable", () => {
    const text = "a".repeat(5_000);
    const html = renderToStaticMarkup(<AssistantMarkdown>{text}</AssistantMarkdown>);
    expect(html).toContain("max-w-[72ch]");
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain(text);
  });
});

describe("assistant message states", () => {
  const noop = () => undefined;

  it("renders a useful empty response state", () => {
    const html = renderToStaticMarkup(
      <AgentBlocks blocks={[]} onConfirmDone={noop} onFollowUp={noop} />,
    );
    expect(html).toContain("returned no answer");
  });

  it("marks errors as alerts and labels assistant responses", () => {
    const html = renderToStaticMarkup(
      <AgentBlocks
        blocks={[{ type: "warning", text: "Could not finish." }]}
        onConfirmDone={noop}
        onFollowUp={noop}
      />,
    );
    expect(html).toContain('aria-label="Kosh response"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-message-kind="error"');
  });

  it("renders finance cards from structured blocks and keeps currency warnings explicit", () => {
    const html = renderToStaticMarkup(
      <AgentBlocks
        blocks={[
          {
            type: "budgets",
            title: "Budget status",
            period: "July 2026",
            rows: [{
              id: "budget-1",
              name: "Food",
              plannedMinor: 20_000,
              spentMinor: 12_000,
              remainingMinor: 8_000,
              ratio: 0.6,
              isOver: false,
              currency: "INR",
            }],
          },
          {
            type: "currencyWarning",
            defaultCurrency: "INR",
            otherCurrencies: ["USD"],
            text: "Totals use INR. Other currencies are shown separately and are not added to it.",
          },
        ]}
        onConfirmDone={noop}
        onFollowUp={noop}
      />,
    );
    expect(html).toContain("Budget status");
    expect(html).toContain("₹200");
    expect(html).toContain("Currency boundary");
    expect(html).toContain("USD");
  });
});
