import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { MagicWand01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { getUserSettings } from "@/modules/settings/queries";
import { listAccounts } from "@/modules/accounts/queries";
import { listCategories, listTags } from "@/modules/taxonomy/queries";
import {
  getRuleSuggestions,
  listRuleRuns,
  listRules,
} from "@/modules/rules/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NewRuleDialog } from "./new-rule-dialog";
import { RuleList } from "./rule-list";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [
    settings,
    rules,
    runs,
    suggestions,
    accounts,
    categories,
    tags,
  ] = await Promise.all([
    getUserSettings(user.id),
    listRules(user.id),
    listRuleRuns(user.id, 8),
    getRuleSuggestions(user.id),
    listAccounts(user.id),
    listCategories(user.id),
    listTags(user.id),
  ]);
  const contains = typeof params.contains === "string" ? params.contains : undefined;
  const category =
    typeof params.category === "string" ? params.category : undefined;

  return (
    <>
      <PageHeader
        title="Automations"
        description="Rules for import cleanup and review"
      >
        <NewRuleDialog
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          tags={tags.map((t) => ({ id: t.id, name: t.name }))}
          currencyCode={settings.currencyCode}
          defaultOpen={params.new === "1"}
          defaultContains={contains}
          defaultCategoryId={category}
        />
      </PageHeader>

      <main className="space-y-5 p-4 md:p-6">
        {suggestions.length > 0 && (
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {suggestions.map((suggestion) => (
              <Card key={suggestion.token} className="gap-3 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      &quot;{suggestion.token}&quot;
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Appears {suggestion.occurrences} times in recent imports.
                    </p>
                  </div>
                  <Badge variant="secondary">Suggestion</Badge>
                </div>
                <Button asChild variant="outline" size="sm" className="w-fit">
                  <Link
                    href={`/automations?new=1&contains=${encodeURIComponent(
                      suggestion.token,
                    )}${
                      suggestion.suggestedCategoryId
                        ? `&category=${suggestion.suggestedCategoryId}`
                        : ""
                    }`}
                  >
                    Create rule
                  </Link>
                </Button>
              </Card>
            ))}
          </section>
        )}

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Rules</h2>
            <p className="text-sm text-muted-foreground">
              Run rules manually here; import-enabled rules also run after CSV commits.
            </p>
          </div>

          {rules.length === 0 ? (
            <Empty className="border border-dashed py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon icon={MagicWand01Icon} />
                </EmptyMedia>
                <EmptyTitle>No automation rules</EmptyTitle>
                <EmptyDescription>
                  Create rules for repeated merchants, categories, tags, and
                  review status.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RuleList
              rules={rules.map((rule) => ({
                id: rule.id,
                name: rule.name,
                description: rule.description,
                isActive: rule.isActive,
                runOnImport: rule.runOnImport,
                matchAll: rule.matchAll,
                conditions: rule.conditions.map((condition) => ({
                  field: condition.field,
                  value: condition.value,
                })),
                actions: rule.actions.map((action) => ({
                  type: action.type,
                  value: action.value,
                })),
                lastRun: rule.runs[0]
                  ? {
                      matchedCount: rule.runs[0].matchedCount,
                      appliedCount: rule.runs[0].appliedCount,
                      error: rule.runs[0].error,
                      startedAt: rule.runs[0].startedAt.toISOString(),
                    }
                  : null,
              }))}
            />
          )}
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="micro-label">Recent runs</CardTitle>
            <CardDescription>Manual and import-triggered executions</CardDescription>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                Rule runs appear here after the first execution.
              </div>
            ) : (
              <ul className="divide-y divide-dashed">
                {runs.map((run) => (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {run.rule?.name ?? "Deleted rule"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {run.trigger} - {run.startedAt.toLocaleString("en-IN")}
                      </p>
                    </div>
                    <p className="font-amount text-xs text-muted-foreground">
                      {run.matchedCount} matched / {run.appliedCount} changed
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
