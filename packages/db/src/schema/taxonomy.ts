import {
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./helpers";
import { users } from "./auth";

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Hugeicons icon name rendered in pickers and lists. */
    icon: text("icon"),
    /** CSS color token or hex used for chart slices and badges. */
    color: text("color"),
    ...timestamps,
  },
  (t) => [
    index("categories_user_id_idx").on(t.userId),
    uniqueIndex("categories_user_name_unique").on(t.userId, t.name),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    ...timestamps,
  },
  (t) => [
    index("tags_user_id_idx").on(t.userId),
    uniqueIndex("tags_user_name_unique").on(t.userId, t.name),
  ],
);
