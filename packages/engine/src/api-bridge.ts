// Bridge routes (Firstmate-style trust surface). Mounted by api.ts AFTER its auth middleware, so `userId` is set and
// every read is scoped to that user.
//   GET  /bearings[?goalId=][&judge=1] → BearingsDTO           (deterministic digest; judge=1: captain re-words "overall")
//   POST /bearings/file { goalId? }     → BearingsFileResponse  (writes data/reports/bearings-<date>-<user>[-<goal>].md)
//   GET  /ahoy[?goalId=][&judge=1]      → AhoyDTO               (since the user's seen-marker + ranked open decisions)
//   POST /ahoy/seen { eventId? }        → AhoySeenResponse
import { Hono, type Context } from "hono";
import { goals, type DB } from "@bulkhead/db";
import { eq } from "drizzle-orm";
import type { AhoySeenResponse, BearingsFileResponse } from "@bulkhead/shared";
import type { Chain } from "@bulkhead/chain";
import type { DecisionLedger, EventBus, LLM } from "./contracts";
import { buildBearings, fileBearings, type BearingsDeps } from "./captain/bearings";
import { buildAhoy, markSeen } from "./captain/ahoy";
import { toJsonSafe } from "./captain/tools";

type Vars = { Variables: { userId: string } };

export interface BridgeApiDeps {
  db: DB;
  bus: EventBus;
  chain: Chain;
  decisions: DecisionLedger;
  llm?: LLM | null;
  pendingSignatures?: BearingsDeps["pendingSignatures"];
  reportsDir?: string;
  now?: () => number;
}

export function createBridgeRoutes(deps: BridgeApiDeps) {
  const app = new Hono<Vars>();
  app.onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 400) as 400));
  const json = (c: Context, v: unknown, status = 200) => c.json(toJsonSafe(v) as object, status as 200);
  const ownGoal = (userId: string, goalId: string | undefined | null) => {
    if (!goalId) return null;
    const g = deps.db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!g || g.userId !== userId) throw Object.assign(new Error("goal not found"), { status: 404 });
    return g;
  };
  const truthy = (v: string | undefined) => v === "1" || v === "true";
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  app.get("/bearings", async (c) => {
    const userId = c.get("userId");
    const g = ownGoal(userId, c.req.query("goalId"));
    return json(c, await buildBearings(deps, userId, g?.id ?? null, { judge: truthy(c.req.query("judge")) }));
  });

  app.post("/bearings/file", async (c) => {
    const userId = c.get("userId");
    const b = await body(c);
    const g = ownGoal(userId, typeof b.goalId === "string" && b.goalId ? b.goalId : null);
    const bearings = await buildBearings(deps, userId, g?.id ?? null, { judge: b.judge === true });
    const { path, file } = fileBearings(bearings, userId, { dir: deps.reportsDir, goalText: g?.goal ?? null });
    const out: BearingsFileResponse = { ok: true, path, file, bearings };
    return json(c, out, 201);
  });

  app.get("/ahoy", async (c) => {
    const userId = c.get("userId");
    const g = ownGoal(userId, c.req.query("goalId"));
    return json(c, await buildAhoy(deps, userId, { goalId: g?.id ?? null, judge: truthy(c.req.query("judge")) }));
  });

  app.post("/ahoy/seen", async (c) => {
    const b = await body(c);
    const eventId = typeof b.eventId === "number" ? b.eventId : typeof b.eventId === "string" && /^\d+$/.test(b.eventId) ? Number(b.eventId) : undefined;
    const out: AhoySeenResponse = { ok: true, seenEventId: markSeen(deps.db, c.get("userId"), eventId) };
    return json(c, out);
  });

  return app;
}
