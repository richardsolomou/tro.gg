/**
 * The tro.gg backend module entry. SpacetimeDB registers a reducer under the name
 * it is exported as from this entry namespace (`moduleHooks` walks these exports),
 * so every reducer, procedure, and lifecycle hook must be re-exported here under its
 * canonical name. The schema, tables, and scheduled reducers live in
 * `schema.ts`; shared server-side helpers in `helpers.ts`; the rest of the reducers
 * are grouped by domain under `reducers/`.
 */
export { default } from "./schema";
export * from "./schema";
export * from "./reducers/lifecycle";
export * from "./reducers/movement";
export * from "./reducers/interact";
export * from "./reducers/admin";
export * from "./reducers/social";
export * from "./reducers/items";
export * from "./reducers/claim";
