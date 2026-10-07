import { describe, expect, it } from "vitest";
import { CliSokosumi, fetchAllEvents, type CoreClient } from "../src/sokosumi";

function pagedCore(pages: Record<string, unknown>): CoreClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    get: async (p: string) => {
      paths.push(p);
      const cursor = new URL(`http://x${p}`).searchParams.get("cursor") ?? "first";
      return pages[cursor];
    },
    post: async () => ({ data: { id: "ev_new" } }),
  };
}

describe("events pagination", () => {
  it("follows nextCursor until null and de-duplicates", async () => {
    const core = pagedCore({
      first: { data: [{ id: "1" }, { id: "2" }], meta: { pagination: { nextCursor: "c2" } } },
      c2: { data: [{ id: "2" }, { id: "3" }], meta: { pagination: { nextCursor: null } } },
    });
    expect((await fetchAllEvents(core, "t 1")).map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(core.paths[0]).toBe("/v1/tasks/t%201/events?limit=100");
  });
  it("a pagination block without nextCursor is not end-of-history", async () => {
    await expect(fetchAllEvents(pagedCore({ first: { data: [], meta: { pagination: {} } } }), "t")).rejects.toThrow(/refusing/);
    expect(await fetchAllEvents(pagedCore({ first: { data: [{ id: "a" }] } }), "t")).toHaveLength(1);
  });
});

describe("CLI argv", () => {
  it("uses the documented subcommands and flags", async () => {
    const argv: string[][] = [];
    const run = async (a: string[]) => {
      argv.push(a);
      if (a[0] === "tasks") return { tasks: [{ id: "t1", status: "READY", coworkerId: "cw" }, { nope: 1 }] };
      if (a[1] === "start") return { id: "t1", name: "n", description: "input", status: "RUNNING" };
      return { taskId: "t1", eventId: "e1", status: "COMPLETED" };
    };
    const core = async () => pagedCore({});
    const s = new CliSokosumi({ coworkerId: "cw" }, run, core);
    expect(await s.listTasks()).toHaveLength(1);
    expect((await s.startTask("t1")).description).toBe("input");
    expect(await s.completeTask("t1", "/r.txt")).toEqual({ eventId: "e1" });
    expect(argv).toEqual([
      ["tasks", "list", "--coworker-id", "cw"],
      ["runtime", "start", "t1", "--personal", "--coworker-id", "cw"],
      ["runtime", "complete", "t1", "--personal", "--coworker-id", "cw", "--result-file", "/r.txt"],
    ]);
    const old = new CliSokosumi({ coworkerId: "cw", organizationId: "org1" }, run, core);
    await old.startTask("t1");
    expect(argv.at(-1)).toEqual(["runtime", "start", "t1", "--organization-id", "org1", "--coworker-id", "cw"]);
  });
});
