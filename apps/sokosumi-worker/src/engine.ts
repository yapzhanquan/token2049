// Bulkhead engine HTTP API (ENGINE_URL, `x-engine-token` = ENGINE_TOKEN, `x-user-id` = the dedicated
// custodial engine user "sokosumi-coworker@bulkhead.local"). Routes per ENGINE_ROUTES in @bulkhead/shared.
import type {
  ActivityDTO,
  ActivityRowDTO,
  ApproveResponse,
  CaptainMessageBody,
  ControlAction,
  CreateUserResponse,
  DecisionDTO,
  GoalSummary,
  PlanBody,
  PlanResponse,
  SessionDetailDTO,
  TreeDTO,
} from "@bulkhead/shared";

export interface EnginePort {
  ensureUser(email: string, name: string): Promise<string>;
  createGoal(userId: string, body: PlanBody): Promise<PlanResponse>;
  listGoals(userId: string): Promise<GoalSummary[]>;
  approveGoal(userId: string, goalId: string): Promise<ApproveResponse>;
  tree(userId: string, goalId: string): Promise<TreeDTO>;
  session(userId: string, sessionId: string): Promise<SessionDetailDTO>;
  decisions(userId: string, status?: "open"): Promise<DecisionDTO[]>;
  decide(userId: string, decisionId: string, status: "approved" | "rejected", note: string): Promise<unknown>;
  control(userId: string, sessionId: string, action: ControlAction, body?: Record<string, unknown>): Promise<unknown>;
  captainMessage(userId: string, body: CaptainMessageBody): Promise<unknown>;
  activity(userId: string, goalId: string): Promise<ActivityRowDTO[]>;
}

export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpEngine implements EnginePort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, userId: string | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", "x-engine-token": this.token };
    if (userId) headers["x-user-id"] = userId;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = (data as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
      throw new EngineHttpError(res.status, `engine ${method} ${path.split("?")[0]}: ${String(err).slice(0, 200)}`);
    }
    return data as T;
  }

  async ensureUser(email: string, name: string) {
    const r = await this.call<CreateUserResponse>("POST", "/users", null, { email, name, custody: "custodial" });
    if (r.custody !== "custodial") throw new Error("engine user is not custodial");
    return r.userId;
  }
  createGoal(userId: string, body: PlanBody) {
    return this.call<PlanResponse>("POST", "/goals", userId, body);
  }
  listGoals(userId: string) {
    return this.call<GoalSummary[]>("GET", "/goals", userId);
  }
  approveGoal(userId: string, goalId: string) {
    return this.call<ApproveResponse>("POST", `/goals/${encodeURIComponent(goalId)}/approve`, userId, {});
  }
  tree(userId: string, goalId: string) {
    return this.call<TreeDTO>("GET", `/goals/${encodeURIComponent(goalId)}/tree`, userId);
  }
  session(userId: string, sessionId: string) {
    return this.call<SessionDetailDTO>("GET", `/sessions/${encodeURIComponent(sessionId)}`, userId);
  }
  decisions(userId: string, status?: "open") {
    return this.call<DecisionDTO[]>("GET", `/decisions${status ? `?status=${status}` : ""}`, userId);
  }
  decide(userId: string, decisionId: string, status: "approved" | "rejected", note: string) {
    return this.call("POST", `/decisions/${encodeURIComponent(decisionId)}`, userId, { status, note });
  }
  control(userId: string, sessionId: string, action: ControlAction, body: Record<string, unknown> = {}) {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/${action}`, userId, body);
  }
  captainMessage(userId: string, body: CaptainMessageBody) {
    return this.call("POST", "/captain/messages", userId, body);
  }
  async activity(userId: string, goalId: string) {
    const rows: ActivityRowDTO[] = [];
    let before: number | null = null;
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ goalId, limit: "200" });
      if (before !== null) q.set("before", String(before));
      const page = await this.call<ActivityDTO>("GET", `/activity?${q}`, userId);
      rows.push(...page.rows);
      if (page.nextBefore === null || page.nextBefore === undefined || !page.rows.length) break;
      before = page.nextBefore;
    }
    return rows;
  }
}
