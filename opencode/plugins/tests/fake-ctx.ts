// Shared fake v2 plugin ctx for the plugin tests. Not a test and not a plugin:
// the runners skip it (no test_ prefix) and discovery skips tests/ (no index/server).
// Hook names are whitelisted so a typo throws instead of becoming a silent no-op.
// Registrations are counted so a dropped `await` fails too (see registered for the
// one shape that slips through).

export const KNOWN = {
  tool: ["execute.before", "execute.after"],
  session: ["prompt", "context", "compaction", "generate", "title", "model.request", "retry", "http.request", "http.response"],
}

// Keys are "<domain>.<name>", e.g. "tool.execute.before", "session.prompt".
export type Hooks = Record<string, Array<(ev: any) => unknown>>

const unknownHook = (domain: string, name: string) => new Error(`unknown hook ${domain}.${name}`)

export function fakeCtx(o: {
  directory?: string
  projectDirectory?: string
  workspaceID?: string
  getSession?: (sessionID: string) => Promise<unknown>
} = {}): { ctx: any; hooks: Hooks; tools: Map<string, any>; assertAwaited: () => void } {
  const hooks: Hooks = {}
  const tools = new Map<string, any>()
  const directory = o.directory ?? "/repo"
  const projectDirectory = o.projectDirectory ?? directory

  // A registration counts as awaited once somebody called its `then` and it has
  // settled. It settles on a macrotask, after setup's own microtasks have drained,
  // so a registration dropped bare, chained with .then, wrapped in Promise.all or
  // awaited inside a helper nobody awaits is still pending when `await
  // plugin.setup(ctx)` returns. A bare thenable, not a Promise: `await` on a
  // native Promise never reads its `then`, so overriding it there would see nothing.
  // ecomono: a non-bare drop followed by an awaited registration slips through,
  // because timers fire in order and setup waits on the later one. Settle
  // registrations in reverse creation order if that shape ever ships.
  let pending = 0
  const registered = () => {
    let seen = false, settled = false
    pending++
    const done = () => seen && settled && pending--
    const p = new Promise((r) => setTimeout(r, 0, { dispose: async () => {} })).then((v) => ((settled = true), done(), v))
    return { then: (ok?: any, ko?: any) => (seen || ((seen = true), done()), p.then(ok, ko)) }
  }
  // Call right after `await plugin.setup(ctx)`: setup must await every hook and
  // transform registration before it resolves (C2).
  const assertAwaited = () => {
    if (pending) throw new Error(`setup resolved with ${pending} hook/transform registration(s) not awaited`)
  }

  const domain = (d: keyof typeof KNOWN) => ({
    hook: (name: string, cb: (ev: any) => unknown) => {
      if (!KNOWN[d].includes(name)) throw unknownHook(d, name)
      ;(hooks[`${d}.${name}`] ??= []).push(cb)
      return registered()
    },
  })

  const ctx: any = {
    location: {
      directory,
      workspaceID: o.workspaceID,
      project: { id: "p", directory: projectDirectory, canonical: projectDirectory },
    },
    tool: {
      ...domain("tool"),
      transform: (cb: (api: { add: (t: any) => void }) => unknown) => {
        cb({ add: (t) => tools.set(t.name, t) })
        return registered()
      },
    },
    session: {
      ...domain("session"),
      get: async ({ sessionID }: { sessionID: string }) =>
        (await o.getSession?.(sessionID)) ??
        (sessionID.startsWith("child") ? { id: sessionID, parentID: "root" } : { id: sessionID }),
    },
  }

  // A misspelled domain (ctx.sesion.hook(...)) also throws "unknown hook".
  const guarded = new Proxy(ctx, {
    get: (t, k, r) =>
      k in t || typeof k === "symbol" || k === "then"
        ? Reflect.get(t, k, r)
        : { hook: (name: string) => { throw unknownHook(String(k), name) } },
  })
  return { ctx: guarded, hooks, tools, assertAwaited }
}

// Runs callbacks sequentially (mirrors OC/core/src/plugin/hooks.ts:88-95); returns the event.
export async function fire(hooks: Hooks, key: string, ev: any): Promise<any> {
  for (const cb of hooks[key] ?? []) await cb(ev)
  return ev
}
