// A minimal stand-in for `spacetimedb/server`, aliased in for tests via test/tsconfig.json.
// The real server module only loads inside SpacetimeDB's host runtime (it won't import
// under node), so this mock lets `spacetimedb/src/index.ts` *evaluate* — define its tables
// and reducers — while the test supplies a fake `ctx` (test/spacetime.ts) at call time.
// `spacetimedb.reducer(opts, fn)` returns a function that just invokes the handler, so a
// reducer export is directly callable: `move(ctx, { dirX, dirY, running })`.

/** A chainable column builder. Only needs to not throw at definition time; the fake ctx
 *  owns the real table semantics, so the column metadata here is inert. */
function col(): any {
  const c: any = {};
  c.primaryKey = () => c;
  c.autoInc = () => c;
  c.index = () => c;
  c.default = () => c;
  return c;
}

export const t = {
  i32: col,
  u64: col,
  i64: col,
  f32: col,
  f64: col,
  bool: col,
  string: col,
  identity: col,
  timestamp: col,
  scheduleAt: col,
  option: (_inner?: unknown) => col(),
};

export function table(_opts: unknown, cols?: unknown): any {
  return { rowType: cols ?? {} };
}

type Handler = (...args: any[]) => unknown;
const callable = (fn: Handler) => (...args: any[]) => fn(...args);

export function schema(_tables: unknown): any {
  return {
    reducer: (a: unknown, b?: Handler) => callable(typeof a === "function" ? (a as Handler) : (b as Handler)),
    clientConnected: (fn: Handler) => callable(fn),
    clientDisconnected: (fn: Handler) => callable(fn),
    init: (fn: Handler) => callable(fn),
  };
}
