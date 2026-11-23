import { z } from "zod";

/** A PostgreSQL identifier (schema, table, column, index). Quoted before use, never interpolated raw. */
export const identifier = z.string().min(1).max(63);

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Equality filters: a value, null (IS NULL), or a list (= ANY). */
export const whereSchema = z.record(z.string(), z.union([scalar, z.null(), z.array(scalar)]));

/** A non-empty filter — mutating tools never run without one. */
export const requiredWhereSchema = whereSchema.refine((w) => Object.keys(w).length > 0, {
  message: "A non-empty 'where' is required; whole-table changes are refused.",
});

/** Column values for INSERT/UPDATE. Objects are stored as JSON. */
export const rowSchema = z.record(z.string(), z.unknown());

export const paramsSchema = z.array(z.union([scalar, z.null()]));
