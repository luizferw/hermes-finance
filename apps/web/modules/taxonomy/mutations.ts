"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { categories, db, tags } from "@kosh/db";
import { requireUser } from "@/lib/session";
import { logAudit } from "@/modules/shared/audit";

const nameSchema = z.string().min(1).max(60);

export async function createCategory(input: {
  name: string;
  icon?: string;
  color?: string;
}) {
  const user = await requireUser();
  const name = nameSchema.parse(input.name);
  const [category] = await db
    .insert(categories)
    .values({ userId: user.id, name, icon: input.icon, color: input.color })
    .onConflictDoNothing()
    .returning();
  await logAudit({
    userId: user.id,
    action: "category.created",
    entityType: "category",
    entityId: category?.id,
    data: { name },
  });
  revalidatePath("/transactions");
  return category;
}

export async function createTag(input: { name: string; color?: string }) {
  const user = await requireUser();
  const name = nameSchema.parse(input.name);
  const [tag] = await db
    .insert(tags)
    .values({ userId: user.id, name, color: input.color })
    .onConflictDoNothing()
    .returning();
  await logAudit({
    userId: user.id,
    action: "tag.created",
    entityType: "tag",
    entityId: tag?.id,
    data: { name },
  });
  revalidatePath("/transactions");
  return tag;
}
