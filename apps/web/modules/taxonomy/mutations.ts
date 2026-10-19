"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { categories, db, tags } from "@kosh/db";
import { requireUser } from "@/lib/session";
import { logAudit } from "@/modules/shared/audit";

const nameSchema = z.string().min(1).max(60);

/**
 * Session-free create. Returns `undefined` when the user already has a
 * category with this name (the unique index wins and nothing is written).
 */
export async function createCategoryCore(
  userId: string,
  input: { name: string; icon?: string; color?: string },
) {
  const name = nameSchema.parse(input.name);
  const [category] = await db
    .insert(categories)
    .values({ userId, name, icon: input.icon, color: input.color })
    .onConflictDoNothing()
    .returning();
  await logAudit({
    userId,
    action: "category.created",
    entityType: "category",
    entityId: category?.id,
    data: { name },
  });
  return category;
}

export async function createCategory(input: {
  name: string;
  icon?: string;
  color?: string;
}) {
  const user = await requireUser();
  const category = await createCategoryCore(user.id, input);
  revalidatePath("/transactions");
  return category;
}

/** Session-free create; `undefined` when the tag name already exists. */
export async function createTagCore(
  userId: string,
  input: { name: string; color?: string },
) {
  const name = nameSchema.parse(input.name);
  const [tag] = await db
    .insert(tags)
    .values({ userId, name, color: input.color })
    .onConflictDoNothing()
    .returning();
  await logAudit({
    userId,
    action: "tag.created",
    entityType: "tag",
    entityId: tag?.id,
    data: { name },
  });
  return tag;
}

export async function createTag(input: { name: string; color?: string }) {
  const user = await requireUser();
  const tag = await createTagCore(user.id, input);
  revalidatePath("/transactions");
  return tag;
}
