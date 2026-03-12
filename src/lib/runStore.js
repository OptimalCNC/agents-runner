import fs from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortRuns(runs) {
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function normalizeMode(value) {
  return value === "generated" || value === "task-generator" ? "generated" : "repeated";
}

function buildSummary(run) {
  const completedAgents = run.agents.filter((agent) => agent.status === "completed").length;
  const failedAgents = run.agents.filter((agent) => agent.status === "failed").length;
  const cancelledAgents = run.agents.filter((agent) => agent.status === "cancelled").length;
  const runningAgents = run.agents.filter((agent) => agent.status === "running").length;
  const queuedAgents = run.agents.filter((agent) => agent.status === "queued").length;

  return {
    id: run.id,
    mode: run.mode,
    title: run.title,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cancelRequested: run.cancelRequested,
    totalAgents: run.agents.length,
    completedAgents,
    failedAgents,
    cancelledAgents,
    runningAgents,
    queuedAgents,
    config: run.config,
    generation: run.generation,
  };
}

export function createRunStore(dataDirectory) {
  const dataFile = path.join(dataDirectory, "runs.json");
  const runs = new Map();
  const subscribers = new Set();
  const pendingRunBroadcasts = new Set();
  let persistTimer = null;
  let broadcastTimer = null;

  async function ensureDataDirectory() {
    await fs.mkdir(dataDirectory, { recursive: true });
  }

  function serializeRuns() {
    return sortRuns(Array.from(runs.values()).map((run) => clone(run)));
  }

  function schedulePersist() {
    if (persistTimer) {
      return;
    }

    persistTimer = setTimeout(async () => {
      persistTimer = null;
      try {
        await ensureDataDirectory();
        await fs.writeFile(dataFile, `${JSON.stringify(serializeRuns(), null, 2)}\n`, "utf8");
      } catch (error) {
        console.error("Failed to persist runs", error);
      }
    }, 150);
  }

  function writeSse(response, eventName, payload) {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function flushBroadcasts() {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
    }
    broadcastTimer = null;

    if (pendingRunBroadcasts.size === 0 || subscribers.size === 0) {
      pendingRunBroadcasts.clear();
      return;
    }

    const runIds = Array.from(pendingRunBroadcasts);
    pendingRunBroadcasts.clear();

    for (const runId of runIds) {
      const run = runs.get(runId);
      if (!run) {
        continue;
      }

      const payload = {
        summary: buildSummary(run),
        run: clone(run),
      };

      for (const response of subscribers) {
        writeSse(response, "run.updated", payload);
      }
    }
  }

  function scheduleBroadcast(runId) {
    pendingRunBroadcasts.add(runId);

    if (broadcastTimer) {
      return;
    }

    broadcastTimer = setTimeout(flushBroadcasts, 100);
  }

  function queueRunUpdate(runId) {
    schedulePersist();
    scheduleBroadcast(runId);
  }

  async function load() {
    await ensureDataDirectory();

    try {
      const fileContent = await fs.readFile(dataFile, "utf8");
      const persistedRuns = JSON.parse(fileContent);

      for (const run of persistedRuns) {
        run.mode = normalizeMode(run.mode ?? run.workflowType);
        delete run.workflowType;

        if (run.status === "running" || run.status === "queued") {
          run.status = "failed";
          run.completedAt = nowIso();
          run.error = "Interrupted by server restart.";

          for (const agent of run.agents) {
            if (agent.status === "running" || agent.status === "queued") {
              agent.status = "failed";
              agent.completedAt = nowIso();
              agent.error = "Interrupted by server restart.";
            }
          }
        }

        runs.set(run.id, run);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  function listSummaries() {
    return sortRuns(Array.from(runs.values()).map(buildSummary));
  }

  function getRun(runId) {
    const run = runs.get(runId);
    return run ? clone(run) : null;
  }

  function getMutableRun(runId) {
    return runs.get(runId) ?? null;
  }

  function createRun({
    mode,
    title,
    config,
  }) {
    const id = createId();
    const run = {
      id,
      mode,
      title,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      cancelRequested: false,
      error: null,
      config,
      generation: mode === "generated"
        ? {
            status: "pending",
            startedAt: null,
            completedAt: null,
            error: null,
            tasks: [],
          }
        : null,
      agents: [],
    };

    runs.set(id, run);
    queueRunUpdate(id);
    return clone(run);
  }

  function updateRun(runId, updater) {
    const run = runs.get(runId);
    if (!run) {
      return null;
    }

    updater(run);
    queueRunUpdate(runId);
    return clone(run);
  }

  function appendAgent(runId, agent) {
    return updateRun(runId, (run) => {
      run.agents.push(agent);
    });
  }

  function updateAgent(runId, agentId, updater) {
    return updateRun(runId, (run) => {
      const agent = run.agents.find((entry) => entry.id === agentId);
      if (agent) {
        updater(agent, run);
      }
    });
  }

  function subscribe(response) {
    subscribers.add(response);
    writeSse(response, "runs.snapshot", { runs: listSummaries() });

    return () => {
      subscribers.delete(response);
    };
  }

  return {
    load,
    listSummaries,
    getRun,
    getMutableRun,
    createRun,
    updateRun,
    appendAgent,
    updateAgent,
    subscribe,
  };
}
