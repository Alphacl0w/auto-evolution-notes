const AGENT_A = ["a:scan", "a:update-primary", "a:reconcile-scan"];
const AGENT_B = ["b:read-primary", "b:create-canary", "b:add-route"];

function interleave(left, right, prefix = []) {
  if (left.length === 0) return [[...prefix, ...right]];
  if (right.length === 0) return [[...prefix, ...left]];

  return [
    ...interleave(left.slice(1), right, [...prefix, left[0]]),
    ...interleave(left, right.slice(1), [...prefix, right[0]]),
  ];
}

function execute(schedule, mode) {
  const state = {
    deployments: new Map([["primary", "v1"]]),
    routeReady: false,
  };
  const local = {
    aScan: [],
    bPremise: null,
  };
  let extraOperations = 0;

  for (const step of schedule) {
    if (step === "a:scan") {
      local.aScan = [...state.deployments.keys()];
    } else if (step === "a:update-primary") {
      state.deployments.set("primary", "v2");
    } else if (step === "a:reconcile-scan") {
      for (const name of local.aScan) state.deployments.set(name, "v2");
    } else if (step === "b:read-primary") {
      local.bPremise = state.deployments.get("primary");
    } else if (step === "b:create-canary") {
      state.deployments.set("canary", local.bPremise);
    } else if (step === "b:add-route") {
      state.routeReady = true;
    }
  }

  const premiseChanged = local.bPremise !== state.deployments.get("primary");

  if (mode === "occ-retry" && premiseChanged) {
    local.bPremise = state.deployments.get("primary");
    state.deployments.set("canary", local.bPremise);
    state.routeReady = true;
    extraOperations += 3;
  }

  if (
    mode === "targeted-repair" &&
    premiseChanged &&
    state.deployments.get("canary") !== state.deployments.get("primary")
  ) {
    state.deployments.set("canary", state.deployments.get("primary"));
    extraOperations += 1;
  }

  const serializable =
    state.deployments.get("primary") === "v2" &&
    state.deployments.get("canary") === "v2" &&
    state.routeReady;

  return {
    serializable,
    premiseChanged,
    extraOperations,
    final: {
      primary: state.deployments.get("primary"),
      canary: state.deployments.get("canary"),
      routeReady: state.routeReady,
    },
  };
}

function summarize(schedules, mode) {
  const runs = schedules.map((schedule) => ({
    schedule,
    ...execute(schedule, mode),
  }));

  return {
    mode,
    schedules: runs.length,
    serializable: runs.filter((run) => run.serializable).length,
    stalePremises: runs.filter((run) => run.premiseChanged).length,
    schedulesWithExtraWork: runs.filter((run) => run.extraOperations > 0).length,
    extraOperations: runs.reduce((sum, run) => sum + run.extraOperations, 0),
    failures: runs
      .filter((run) => !run.serializable)
      .map((run) => ({ schedule: run.schedule.join(" -> "), final: run.final })),
  };
}

const schedules = interleave(AGENT_A, AGENT_B);

console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        modelCalls: 0,
        schedules: "all order-preserving interleavings of two three-step agents",
      },
      serialOutcomes: [
        { order: "A then B", primary: "v2", canary: "v2", routeReady: true },
        { order: "B then A", primary: "v2", canary: "v2", routeReady: true },
      ],
      results: [
        summarize(schedules, "naive"),
        summarize(schedules, "occ-retry"),
        summarize(schedules, "targeted-repair"),
      ],
    },
    null,
    2,
  ),
);
