import { relations } from "drizzle-orm";
import {
  accounts,
  accountBalances,
  automationRuleActions,
  automationRuleConditions,
  automationRules,
  automationRuns,
  bills,
  budgetCategories,
  budgetPeriods,
  budgets,
  categories,
  importFiles,
  importRows,
  recurringTransactions,
  savingsGoals,
  tags,
  transactionMetadata,
  transactionSplits,
  transactionTags,
  transactions,
} from "./schema";

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
  balances: many(accountBalances),
}));

export const accountBalancesRelations = relations(
  accountBalances,
  ({ one }) => ({
    account: one(accounts, {
      fields: [accountBalances.accountId],
      references: [accounts.id],
    }),
  }),
);

export const categoriesRelations = relations(categories, ({ many }) => ({
  transactions: many(transactions),
  budgetCategories: many(budgetCategories),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  transactionTags: many(transactionTags),
}));

export const transactionsRelations = relations(
  transactions,
  ({ one, many }) => ({
    account: one(accounts, {
      fields: [transactions.accountId],
      references: [accounts.id],
    }),
    transferAccount: one(accounts, {
      fields: [transactions.transferAccountId],
      references: [accounts.id],
    }),
    category: one(categories, {
      fields: [transactions.categoryId],
      references: [categories.id],
    }),
    bill: one(bills, {
      fields: [transactions.billId],
      references: [bills.id],
    }),
    importFile: one(importFiles, {
      fields: [transactions.importFileId],
      references: [importFiles.id],
    }),
    recurringTransaction: one(recurringTransactions, {
      fields: [transactions.recurringTransactionId],
      references: [recurringTransactions.id],
    }),
    suspectedDuplicateOf: one(transactions, {
      fields: [transactions.suspectedDuplicateOfId],
      references: [transactions.id],
      relationName: "duplicates",
    }),
    splits: many(transactionSplits),
    transactionTags: many(transactionTags),
    metadata: many(transactionMetadata),
  }),
);

export const transactionSplitsRelations = relations(
  transactionSplits,
  ({ one }) => ({
    transaction: one(transactions, {
      fields: [transactionSplits.transactionId],
      references: [transactions.id],
    }),
    category: one(categories, {
      fields: [transactionSplits.categoryId],
      references: [categories.id],
    }),
  }),
);

export const transactionTagsRelations = relations(
  transactionTags,
  ({ one }) => ({
    transaction: one(transactions, {
      fields: [transactionTags.transactionId],
      references: [transactions.id],
    }),
    tag: one(tags, {
      fields: [transactionTags.tagId],
      references: [tags.id],
    }),
  }),
);

export const transactionMetadataRelations = relations(
  transactionMetadata,
  ({ one }) => ({
    transaction: one(transactions, {
      fields: [transactionMetadata.transactionId],
      references: [transactions.id],
    }),
  }),
);

export const importFilesRelations = relations(importFiles, ({ one, many }) => ({
  account: one(accounts, {
    fields: [importFiles.accountId],
    references: [accounts.id],
  }),
  rows: many(importRows),
}));

export const importRowsRelations = relations(importRows, ({ one }) => ({
  importFile: one(importFiles, {
    fields: [importRows.importFileId],
    references: [importFiles.id],
  }),
  duplicateOfTransaction: one(transactions, {
    fields: [importRows.duplicateOfTransactionId],
    references: [transactions.id],
    relationName: "rowDuplicateOf",
  }),
  transaction: one(transactions, {
    fields: [importRows.transactionId],
    references: [transactions.id],
    relationName: "rowCreated",
  }),
}));

export const budgetsRelations = relations(budgets, ({ many }) => ({
  periods: many(budgetPeriods),
  budgetCategories: many(budgetCategories),
}));

export const budgetCategoriesRelations = relations(
  budgetCategories,
  ({ one }) => ({
    budget: one(budgets, {
      fields: [budgetCategories.budgetId],
      references: [budgets.id],
    }),
    category: one(categories, {
      fields: [budgetCategories.categoryId],
      references: [categories.id],
    }),
  }),
);

export const budgetPeriodsRelations = relations(budgetPeriods, ({ one }) => ({
  budget: one(budgets, {
    fields: [budgetPeriods.budgetId],
    references: [budgets.id],
  }),
}));

export const billsRelations = relations(bills, ({ one, many }) => ({
  account: one(accounts, {
    fields: [bills.accountId],
    references: [accounts.id],
  }),
  category: one(categories, {
    fields: [bills.categoryId],
    references: [categories.id],
  }),
  transactions: many(transactions),
}));

export const recurringTransactionsRelations = relations(
  recurringTransactions,
  ({ one, many }) => ({
    account: one(accounts, {
      fields: [recurringTransactions.accountId],
      references: [accounts.id],
    }),
    category: one(categories, {
      fields: [recurringTransactions.categoryId],
      references: [categories.id],
    }),
    generatedTransactions: many(transactions),
  }),
);

export const savingsGoalsRelations = relations(savingsGoals, ({ one }) => ({
  account: one(accounts, {
    fields: [savingsGoals.accountId],
    references: [accounts.id],
  }),
}));

export const automationRulesRelations = relations(
  automationRules,
  ({ many }) => ({
    conditions: many(automationRuleConditions),
    actions: many(automationRuleActions),
    runs: many(automationRuns),
  }),
);

export const automationRuleConditionsRelations = relations(
  automationRuleConditions,
  ({ one }) => ({
    rule: one(automationRules, {
      fields: [automationRuleConditions.ruleId],
      references: [automationRules.id],
    }),
  }),
);

export const automationRuleActionsRelations = relations(
  automationRuleActions,
  ({ one }) => ({
    rule: one(automationRules, {
      fields: [automationRuleActions.ruleId],
      references: [automationRules.id],
    }),
  }),
);

export const automationRunsRelations = relations(automationRuns, ({ one }) => ({
  rule: one(automationRules, {
    fields: [automationRuns.ruleId],
    references: [automationRules.id],
  }),
}));
