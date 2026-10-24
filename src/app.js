import { MODELS } from "./models.js";
import { evaluateRequest, estimateTokens, estimateComplexity, formatUsd } from "./engine.js";

const isGitHubPages = window.location.hostname.endsWith(".github.io");

const state = {
  models: MODELS.map(function (model) { return Object.assign({}, model); }),
  overrides: {},
  apiKey: "",
  logs: [],
  currentPlan: null,
  lastExecution: null,
  running: false,
  catalogSource: isGitHubPages ? "Snapshot catalog · live API runs on Vercel" : "Snapshot catalog · refreshes when available"
};

state.models.forEach(function (model) {
  state.overrides[model.id] = { available: true, latencyMs: model.latencyMs, failNext: false };
});

const scenarios = {
  quick: {
    prompt: "What is 19 × 23? Show the arithmetic briefly.",
    latency: 1500,
    cost: 3,
    capability: 1,
    context: 8192,
    output: 256,
    preference: "cost"
  },
  contract: {
    prompt: "Review this service agreement. Summarize payment obligations, renewal and termination terms, and flag any clauses that conflict with the stated goal of ending the contract after the first year. Explain the relevant language and distinguish direct evidence from assumptions.",
    latency: 2400,
    cost: 20,
    capability: 3,
    context: 32768,
    output: 512,
    preference: "quality"
  },
  code: {
    prompt: "Review this authentication handler for security and correctness. Identify exploitable edge cases, explain the root cause of each issue, and propose a minimal patch with a regression scenario.",
    latency: 1800,
    cost: 8,
    capability: 3,
    context: 32768,
    output: 512,
    preference: "cost"
  },
  budget: {
    prompt: "Write a one-sentence summary of why an API gateway uses a fallback model.",
    latency: 1000,
    cost: 2,
    capability: 1,
    context: 8192,
    output: 128,
    preference: "cost"
  }
};

const el = function (id) { return document.getElementById(id); };
const promptInput = el("promptInput");
const latencyInput = el("latencyInput");
const costInput = el("costInput");
const capabilityInput = el("capabilityInput");
const contextInput = el("contextInput");
const outputInput = el("outputInput");
const preferenceInput = el("preferenceInput");
const modelRows = el("modelRows");
const connectDialog = el("connectDialog");
const runButton = el("runButton");

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function commas(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function contextLabel(value) {
  const n = Number(value);
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0).replace(/\.0$/, "") + "M";
  return Math.round(n / 1024) + "K";
}

function qualityLabel(value) {
  return ["", "Simple", "General", "Skilled", "Advanced", "Expert"][Number(value)] || "General";
}

function vendorClass(vendor) {
  const key = String(vendor || "").toLowerCase();
  if (key.indexOf("google") >= 0) return "vendor-google";
  if (key.indexOf("openai") >= 0) return "vendor-openai";
  if (key.indexOf("meta") >= 0) return "vendor-meta";
  if (key.indexOf("anthropic") >= 0) return "vendor-anthropic";
  return "vendor-deepseek";
}

function vendorGlyph(vendor) {
  const key = String(vendor || "").toLowerCase();
  if (key.indexOf("google") >= 0) return "G";
  if (key.indexOf("openai") >= 0) return "O";
  if (key.indexOf("meta") >= 0) return "M";
  if (key.indexOf("anthropic") >= 0) return "A";
  return "D";
}

function currentRequest() {
  return {
    prompt: promptInput.value,
    maxLatencyMs: Number(latencyInput.value),
    maxCostUsd: Number(costInput.value) / 1000,
    minCapability: Number(capabilityInput.value),
    requiredContextTokens: Number(contextInput.value),
    maxOutputTokens: Number(outputInput.value),
    preference: preferenceInput.value
  };
}

function updateControlReadouts() {
  const request = currentRequest();
  const complexity = estimateComplexity(request.prompt);
  const tokens = estimateTokens(request.prompt);
  const effectiveContext = Math.max(request.requiredContextTokens, tokens + request.maxOutputTokens);

  el("latencyValue").textContent = commas(request.maxLatencyMs);
  el("costValue").textContent = "$" + request.maxCostUsd.toFixed(4);
  el("capabilityValue").textContent = "Level " + request.minCapability;
  el("contextValue").textContent = contextLabel(request.requiredContextTokens) + " tokens";
  el("tokenCount").textContent = commas(tokens);
  el("complexityText").textContent = "Level " + complexity.level + " · " + complexity.confidence + " confidence";
  el("complexityNote").title = complexity.reason + ". Effective context: " + commas(effectiveContext) + " tokens.";
}

function updatePlan() {
  updateControlReadouts();
  const request = currentRequest();
  state.currentPlan = evaluateRequest(request, state.models, state.overrides);
  state.lastExecution = null;
  renderDecision(state.currentPlan, null);
}

function preferenceText(plan) {
  if (plan.preference === "latency") return "Lowest p95 latency among models that pass every hard check.";
  if (plan.preference === "quality") return "Highest capability among models that pass every hard check.";
  return "Lowest estimated cost among models that pass every hard check. Ties break on p95 latency.";
}

function reasonFor(plan, winner) {
  if (plan.preference === "latency") return "Chosen for the lowest estimated p95 latency while meeting the cost, capability, and context limits.";
  if (plan.preference === "quality") return "Chosen for the highest available capability while remaining inside the latency, cost, and context limits.";
  return "Chosen as the lowest-cost eligible model. Every hard constraint passed; ties are resolved by lower p95 latency.";
}

function executionAttemptMap(execution) {
  const map = {};
  (execution && execution.attempts ? execution.attempts : []).forEach(function (attempt) {
    map[attempt.modelId] = attempt;
  });
  return map;
}

function traceRows(plan, execution) {
  const attempts = executionAttemptMap(execution);
  const ordered = plan.eligible;
  const rank = {};
  ordered.forEach(function (model, index) { rank[model.id] = index; });

  return plan.models.map(function (model) {
    const attempt = attempts[model.id];
    let status = "rejected";
    let statusLabel = "REJECTED";
    let message = model.reasons[0] || "Does not meet a hard constraint.";
    let rowClass = "";

    if (attempt) {
      if (attempt.status === "selected") {
        status = "selected";
        statusLabel = "SELECTED";
        message = attempt.reason;
        rowClass = " trace-winner";
      } else if (attempt.status === "failed") {
        status = "failed";
        statusLabel = "FAILED";
        message = attempt.reason;
      } else if (attempt.status === "skipped" || attempt.status === "rejected") {
        status = "rejected";
        statusLabel = "SKIPPED";
        message = attempt.reason;
      }
    } else if (model.eligible) {
      const index = rank[model.id];
      if (index === 0 && !(execution && execution.ok)) {
        status = "selected";
        statusLabel = "TOP PICK";
        message = "First in the " + plan.preference + " ranking; all hard checks pass.";
        rowClass = " trace-winner";
      } else {
        status = "fallback";
        statusLabel = "FALLBACK " + (index + 1);
        message = "Eligible alternate; all hard checks pass.";
      }
    } else if (!model.available) {
      status = "offline";
      statusLabel = "OFFLINE";
      message = model.reasons[0];
    }

    return '<div class="trace-row' + rowClass + '">' +
      '<span class="trace-model" title="' + escapeHtml(model.name) + '">' + escapeHtml(model.name) + '</span>' +
      '<span class="trace-reason" title="' + escapeHtml(message) + '">' + escapeHtml(message) + '</span>' +
      '<span class="trace-status ' + status + '">' + escapeHtml(statusLabel) + '</span>' +
    '</div>';
  }).join("");
}

function resultMarkup(plan, execution) {
  if (!plan.winner) {
    return '<div class="no-route-card"><span class="no-route-icon">!</span><span class="no-route-copy"><strong>No eligible model</strong><span>No request was sent. Increase a limit or change the request; the router will not relax your constraints.</span></span></div>';
  }

  const selected = execution && execution.model ? execution.model : plan.winner;
  const estimate = execution && execution.ok ? Number(execution.costUsd || 0) : (selected.costEstimate ? selected.costEstimate.total : plan.winner.costEstimate.total);
  const selectedLatency = selected.measuredLatencyMs || selected.latencyMs || plan.winner.measuredLatencyMs;
  const choiceLabel = execution && execution.ok ? (execution.mode === "live" ? "LIVE RESPONSE" : "SIMULATED ROUTE") : "LOWEST-COST VALID ROUTE";
  let result = '<div class="winner-card">' +
    '<div class="winner-top"><span class="winner-badge"><i></i>' + choiceLabel + '</span><span class="winner-mode">' + escapeHtml(selected.vendor.toUpperCase()) + '</span></div>' +
    '<div class="winner-model"><span class="vendor-mark ' + vendorClass(selected.vendor) + '">' + vendorGlyph(selected.vendor) + '</span><span class="winner-name"><strong>' + escapeHtml(selected.name) + '</strong><small>' + escapeHtml(selected.id) + '</small></span></div>' +
    '<div class="winner-reason">' + escapeHtml(execution && execution.ok ? execution.reason : reasonFor(plan, selected)) + '</div>' +
    '<div class="winner-metrics">' +
      '<div class="winner-metric"><span>EST. P95</span><strong>' + commas(selectedLatency) + ' ms</strong></div>' +
      '<div class="winner-metric"><span>' + (execution && execution.ok && execution.mode === "live" ? "ACTUAL COST" : "COST CEILING") + '</span><strong>' + formatUsd(estimate) + '</strong></div>' +
      '<div class="winner-metric"><span>QUALITY / CONTEXT</span><strong>L' + selected.quality + ' · ' + contextLabel(selected.contextTokens) + '</strong></div>' +
    '</div>' +
  '</div>';

  if (execution && execution.ok) {
    const responseText = execution.mode === "live"
      ? execution.text
      : "Simulation only — no provider was called. A live request would be sent to " + selected.name + " if you connect an OpenRouter key.";
    const liveClass = execution.mode === "live" ? " live-response" : "";
    result += '<div class="response-card' + liveClass + '"><div class="response-heading"><span>' + (execution.mode === "live" ? "MODEL RESPONSE" : "SIMULATION RESULT") + '</span><span>' + (execution.mode === "live" ? "OpenRouter" : "No external call") + '</span></div><div class="response-text">' + escapeHtml(responseText || "(The provider returned an empty response.)") + '</div><div class="run-summary"><span class="summary-chip">' + commas(execution.latencyMs) + ' ms end-to-end</span><span class="summary-chip">' + formatUsd(execution.costUsd) + ' charged/estimated</span>' + (execution.failovers ? '<span class="summary-chip">' + execution.failovers + ' failover' + (execution.failovers === 1 ? "" : "s") + '</span>' : '') + '</div></div>';
  } else if (execution && !execution.ok) {
    result += '<div class="response-card"><div class="response-heading"><span>ROUTE STOPPED</span><span>Hard limits kept</span></div><div class="response-text">' + escapeHtml(execution.error || "No constraint-valid attempt completed.") + '</div></div>';
  }
  return result;
}

function renderDecision(plan, execution) {
  if (!plan) return;
  el("decisionResult").innerHTML = resultMarkup(plan, execution);
  el("decisionSubtitle").textContent = plan.winner
    ? plan.eligible.length + " route" + (plan.eligible.length === 1 ? "" : "s") + " pass every hard check."
    : "The request is blocked before inference.";
  el("traceCount").textContent = plan.eligible.length + " / " + plan.models.length + " eligible";
  el("traceList").innerHTML = plan.models.length ? traceRows(plan, execution) : '<div class="trace-empty">No models available.</div>';
  el("fallbackCount").textContent = plan.eligible.length > 1 ? String(plan.eligible.length - 1) : "0";
  el("runButtonText").textContent = state.apiKey ? "Send live request" : "Run simulation";
  runButton.disabled = state.running || !plan.winner;
  el("rerunButton").disabled = state.running;
}

function renderModelPool() {
  modelRows.innerHTML = state.models.map(function (model) {
    const override = state.overrides[model.id];
    const qualityDots = [1, 2, 3, 4, 5].map(function (value) {
      return '<i class="' + (value <= model.quality ? "on" : "") + '"></i>';
    }).join("");
    const availabilityText = override.available ? "Online" : "Offline";
    const sourceTag = model.catalogStatus === "live" ? "Live catalog" : "Snapshot";
    return '<tr data-model-row="' + escapeHtml(model.id) + '">' +
      '<td><div class="model-name-cell"><span class="vendor-mini ' + vendorClass(model.vendor) + '">' + vendorGlyph(model.vendor) + '</span><span class="model-name-copy"><strong>' + escapeHtml(model.name) + '</strong><small>' + escapeHtml(model.vendor) + ' · ' + escapeHtml(model.tier) + '</small></span></div></td>' +
      '<td><span class="quality-rating" title="Capability level ' + model.quality + '">' + qualityDots + '</span><span class="capability-label">L' + model.quality + ' ' + qualityLabel(model.quality) + '</span></td>' +
      '<td class="context-cell">' + contextLabel(model.contextTokens) + '</td>' +
      '<td><div class="latency-cell"><input class="latency-input" data-model-latency="' + escapeHtml(model.id) + '" type="number" min="50" max="120000" step="10" value="' + Number(override.latencyMs) + '" aria-label="Observed p95 latency for ' + escapeHtml(model.name) + '"><span class="ms-label">ms</span></div></td>' +
      '<td class="price-cell">$' + Number(model.inputPricePerMillion).toFixed(2) + ' / $' + Number(model.outputPricePerMillion).toFixed(2) + '<small>input / output per 1M · ' + sourceTag + '</small></td>' +
      '<td><div class="endpoint-cell"><button type="button" class="switch ' + (override.available ? "on" : "") + '" data-model-health="' + escapeHtml(model.id) + '" role="switch" aria-checked="' + String(override.available) + '" aria-label="' + (override.available ? "Mark " + escapeHtml(model.name) + " offline" : "Mark " + escapeHtml(model.name) + " online") + '"></button><span class="endpoint-state">' + availabilityText + '</span></div></td>' +
      '<td><button type="button" class="fail-next-button ' + (override.failNext ? "armed" : "") + '" data-model-fail="' + escapeHtml(model.id) + '"' + (!override.available ? " disabled" : "") + '>' + (override.failNext ? "Fail armed" : "Fail next") + '</button></td>' +
    '</tr>';
  }).join("");
}

function computeQuantile(values, quantile) {
  if (!values.length) return null;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
}

function renderStats() {
  const requests = state.logs.length;
  const costs = state.logs.reduce(function (sum, item) { return sum + Number(item.costUsd || 0); }, 0);
  const latencies = state.logs.filter(function (item) { return Number.isFinite(item.latencyMs); }).map(function (item) { return item.latencyMs; });
  const failures = state.logs.reduce(function (sum, item) { return sum + Number(item.failures || 0); }, 0);
  const failovers = state.logs.reduce(function (sum, item) { return sum + Number(item.failovers || 0); }, 0);
  el("statRequests").textContent = commas(requests);
  el("statCost").textContent = formatUsd(costs);
  const p95 = computeQuantile(latencies, .95);
  el("statLatency").innerHTML = p95 == null ? "—<small> ms</small>" : commas(p95) + "<small> ms</small>";
  el("statFailovers").textContent = commas(failures);
  el("statFailoverCaption").textContent = commas(failovers) + " safe failover" + (failovers === 1 ? "" : "s");
}

function renderActivity() {
  if (!state.logs.length) {
    el("activityRows").innerHTML = '<tr><td colspan="6" class="empty-log">No requests yet. Run a simulation to create the first decision record.</td></tr>';
    return;
  }
  el("activityRows").innerHTML = state.logs.slice().reverse().slice(0, 8).map(function (item) {
    const resultClass = item.failovers ? "failover" : (item.ok ? "success" : (item.failures ? "error" : "blocked"));
    const resultLabel = item.failovers ? "FAILOVER" : (item.ok ? (item.mode === "live" ? "LIVE" : "SIMULATED") : (item.failures ? "FAILED" : "BLOCKED"));
    return '<tr><td>' + escapeHtml(item.time) + '</td><td><span class="activity-request" title="' + escapeHtml(item.prompt) + '">' + escapeHtml(item.prompt) + '</span></td><td class="route-cell">' + escapeHtml(item.modelName || "No route") + '</td><td><span class="result-tag ' + resultClass + '">' + resultLabel + '</span></td><td class="activity-cost">' + formatUsd(item.costUsd) + '</td><td>' + (Number.isFinite(item.latencyMs) ? commas(item.latencyMs) + " ms" : "—") + '</td></tr>';
  }).join("");
}

function updateSessionStatsAndLog(item) {
  state.logs.push(item);
  renderStats();
  renderActivity();
}

function toast(message, kind) {
  const item = document.createElement("div");
  item.className = "toast" + (kind ? " " + kind : "");
  item.textContent = message;
  el("toastRegion").appendChild(item);
  window.setTimeout(function () { item.remove(); }, 3400);
}

function sleep(ms) {
  return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
}

function safeAttemptTime(model, elapsed, plan) {
  return elapsed + model.measuredLatencyMs <= plan.maxLatencyMs;
}

function simulateRoute(plan) {
  return new Promise(async function (resolve) {
    const attempts = [];
    let elapsed = 0;
    let reservedSpend = 0;
    let winner = null;
    let failovers = 0;

    for (const candidate of plan.eligible) {
      const override = state.overrides[candidate.id];
      if (reservedSpend + candidate.costEstimate.total > plan.maxCostUsd) {
        attempts.push({ modelId: candidate.id, status: "skipped", reason: "Remaining cost budget cannot cover another bounded attempt." });
        continue;
      }

      if (override.failNext) {
        const failureTime = Math.max(25, Math.min(180, Math.round(candidate.measuredLatencyMs * .22)));
        if (elapsed + failureTime > plan.maxLatencyMs) {
          attempts.push({ modelId: candidate.id, status: "skipped", reason: "Failure handling would exceed the remaining end-to-end latency budget." });
          override.failNext = false;
          continue;
        }
        await sleep(failureTime);
        elapsed += failureTime;
        reservedSpend += candidate.costEstimate.total;
        override.failNext = false;
        attempts.push({ modelId: candidate.id, status: "failed", latencyMs: failureTime, reservedCostUsd: candidate.costEstimate.total, reason: "Injected one-shot endpoint failure for this demo." });
        failovers += 1;
        continue;
      }

      if (!safeAttemptTime(candidate, elapsed, plan)) {
        attempts.push({ modelId: candidate.id, status: "skipped", reason: "P95 estimate does not fit the remaining end-to-end latency budget." });
        continue;
      }

      await sleep(candidate.measuredLatencyMs);
      elapsed += candidate.measuredLatencyMs;
      reservedSpend += candidate.costEstimate.total;
      winner = candidate;
      attempts.push({
        modelId: candidate.id,
        status: "selected",
        latencyMs: candidate.measuredLatencyMs,
        costUsd: candidate.costEstimate.total,
        reason: attempts.some(function (item) { return item.status === "failed"; }) ? "Eligible failover succeeded inside the remaining budget." : "Lowest-cost eligible model completed in the simulator."
      });
      break;
    }

    resolve({
      ok: Boolean(winner),
      mode: "simulation",
      model: winner,
      attempts: attempts,
      text: "",
      costUsd: reservedSpend,
      latencyMs: elapsed,
      failovers: winner ? Math.max(0, attempts.filter(function (item) { return item.status === "failed"; }).length) : 0,
      reason: winner ? reasonFor(plan, winner) : "",
      error: winner ? "" : "Every valid attempt failed or the remaining cost / latency budget could not cover another model. No constraint was relaxed."
    });
  });
}

async function runLive(plan) {
  const modelOverrides = {};
  state.models.forEach(function (model) {
    const override = state.overrides[model.id];
    modelOverrides[model.id] = { available: override.available, latencyMs: override.latencyMs };
  });
  const response = await fetch("/api/route", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + state.apiKey
    },
    body: JSON.stringify({
      prompt: plan.prompt,
      constraints: {
        maxLatencyMs: plan.maxLatencyMs,
        maxCostUsd: plan.maxCostUsd,
        minCapability: plan.requestedCapability,
        requiredContextTokens: Number(contextInput.value),
        maxOutputTokens: plan.outputTokens,
        preference: plan.preference
      },
      modelOverrides: modelOverrides
    })
  });
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok || !payload.ok) {
    return {
      ok: false,
      mode: "live",
      attempts: payload.attempts || [],
      error: payload.error || "The live request did not complete.",
      costUsd: payload.totalCostUsd || 0,
      latencyMs: payload.totalLatencyMs,
      model: null,
      failovers: 0
    };
  }
  const attempts = payload.attempts || [];
  return {
    ok: true,
    mode: "live",
    model: payload.model,
    text: payload.text,
    attempts: attempts,
    costUsd: payload.costUsd,
    latencyMs: payload.latencyMs,
    failovers: Math.max(0, attempts.filter(function (item) { return item.status === "failed"; }).length),
    reason: attempts.length > 1 ? "A constraint-valid alternate returned within the original end-to-end limits." : "The selected model returned within the original hard limits.",
    error: ""
  };
}

async function runRequest() {
  if (state.running) return;
  const plan = state.currentPlan;
  if (!plan || !plan.winner) {
    toast("No model meets all current limits. The request was not sent.", "error");
    return;
  }

  state.running = true;
  runButton.disabled = true;
  el("runButtonText").textContent = state.apiKey ? "Routing live…" : "Simulating…";
  let execution;
  try {
    execution = state.apiKey ? await runLive(plan) : await simulateRoute(plan);
  } catch (error) {
    execution = {
      ok: false,
      mode: state.apiKey ? "live" : "simulation",
      attempts: [],
      error: "The route could not be completed. Check the connection and try again.",
      costUsd: 0,
      latencyMs: undefined,
      failovers: 0
    };
  }

  state.running = false;
  state.lastExecution = execution;
  renderDecision(plan, execution);
  renderModelPool();

  const selected = execution.model || null;
  updateSessionStatsAndLog({
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    prompt: plan.prompt,
    modelName: selected ? selected.name : "No route",
    ok: execution.ok,
    mode: execution.mode,
    costUsd: execution.costUsd || 0,
    latencyMs: execution.latencyMs,
    failovers: execution.failovers || 0,
    failures: (execution.attempts || []).filter(function (item) { return item.status === "failed"; }).length
  });
  if (execution.ok && execution.failovers) toast("The first endpoint failed. A constraint-valid fallback completed the request.", "success");
  else if (execution.ok && execution.mode === "live") toast("Live response received from " + selected.name + ".", "success");
  else if (!execution.ok) toast(execution.error, "error");
}

function updateMode() {
  const live = Boolean(state.apiKey);
  const pill = document.querySelector(".environment-pill");
  pill.classList.toggle("live", live);
  el("modeLabel").textContent = live ? "LIVE KEY READY" : (isGitHubPages ? "PAGES DEMO" : "SIMULATOR");
  el("connectButton").style.display = isGitHubPages ? "none" : "";
  el("sidebarMode").textContent = live ? "LIVE / BYOK" : "SIMULATION";
  el("connectLabel").textContent = live ? "Disconnect live" : "Connect live";
  el("runButtonText").textContent = live ? "Send live request" : "Run simulation";
  el("runButton").classList.toggle("button-live", live);
}

function openConnectDialog() {
  if (state.apiKey) {
    state.apiKey = "";
    el("apiKeyInput").value = "";
    updateMode();
    updatePlan();
    toast("Live key cleared from this page session.", "success");
    return;
  }
  el("apiKeyInput").value = "";
  if (typeof connectDialog.showModal === "function") connectDialog.showModal();
  else connectDialog.setAttribute("open", "");
}

function renderPlanAfterCatalog() {
  state.models.forEach(function (model) {
    if (!state.overrides[model.id]) state.overrides[model.id] = { available: true, latencyMs: model.latencyMs, failNext: false };
  });
  renderModelPool();
  updatePlan();
}

async function refreshCatalog(showToast) {
  const refresh = el("refreshCatalog");
  refresh.disabled = true;
  if (isGitHubPages) {
    state.catalogSource = "Snapshot catalog · live API runs on Vercel";
    el("catalogSource").textContent = state.catalogSource;
    el("catalogDot").classList.remove("online");
    refresh.disabled = false;
    if (showToast) toast("GitHub Pages runs the simulator; live API endpoints run on Vercel.", "");
    return;
  }
  el("catalogSource").textContent = "Refreshing model metadata…";
  try {
    const response = await fetch("/api/models", { cache: "no-store" });
    if (!response.ok) throw new Error("catalog refresh unavailable");
    const payload = await response.json();
    const liveModels = new Map((payload.models || []).map(function (model) { return [model.id, model]; }));
    state.models = MODELS.map(function (baseline) {
      const current = liveModels.get(baseline.id) || baseline;
      return Object.assign({}, baseline, current);
    });
    state.catalogSource = payload.source || "Model catalog refreshed";
    el("catalogSource").textContent = state.catalogSource;
    el("catalogDot").classList.toggle("online", String(state.catalogSource).indexOf("Live") >= 0);
    renderPlanAfterCatalog();
    if (showToast) toast("Model metadata refreshed.", "success");
  } catch (error) {
    state.catalogSource = "Snapshot catalog · live endpoint unavailable";
    el("catalogSource").textContent = state.catalogSource;
    el("catalogDot").classList.remove("online");
    if (showToast) toast("Using the included catalog snapshot.", "");
  } finally {
    refresh.disabled = false;
  }
}

function markScenario(name) {
  document.querySelectorAll(".scenario-button").forEach(function (button) {
    button.classList.toggle("selected", button.dataset.scenario === name);
  });
}

function applyScenario(name) {
  const scenario = scenarios[name];
  if (!scenario) return;
  promptInput.value = scenario.prompt;
  latencyInput.value = scenario.latency;
  costInput.value = scenario.cost;
  capabilityInput.value = scenario.capability;
  contextInput.value = scenario.context;
  outputInput.value = scenario.output;
  preferenceInput.value = scenario.preference;
  markScenario(name);
  updatePlan();
}

document.querySelectorAll(".scenario-button").forEach(function (button) {
  button.addEventListener("click", function () { applyScenario(button.dataset.scenario); });
});

[promptInput, latencyInput, costInput, capabilityInput, contextInput, outputInput, preferenceInput].forEach(function (input) {
  input.addEventListener("input", function () {
    if (input === promptInput) markScenario("");
    updatePlan();
  });
  input.addEventListener("change", updatePlan);
});

modelRows.addEventListener("change", function (event) {
  const input = event.target.closest("[data-model-latency]");
  if (!input) return;
  const id = input.dataset.modelLatency;
  const value = Math.max(50, Math.min(120000, Number(input.value) || 50));
  input.value = value;
  state.overrides[id].latencyMs = value;
  state.lastExecution = null;
  updatePlan();
});

modelRows.addEventListener("click", function (event) {
  const health = event.target.closest("[data-model-health]");
  const failure = event.target.closest("[data-model-fail]");
  if (health) {
    const id = health.dataset.modelHealth;
    state.overrides[id].available = !state.overrides[id].available;
    state.lastExecution = null;
    renderModelPool();
    updatePlan();
  } else if (failure) {
    const id = failure.dataset.modelFail;
    state.overrides[id].failNext = !state.overrides[id].failNext;
    renderModelPool();
    toast(state.overrides[id].failNext ? "Next attempt to this endpoint will fail in the simulator." : "One-shot failure removed.", "");
  }
});

runButton.addEventListener("click", runRequest);
el("rerunButton").addEventListener("click", updatePlan);
el("refreshCatalog").addEventListener("click", function () { refreshCatalog(true); });
el("connectButton").addEventListener("click", openConnectDialog);
el("cancelConnect").addEventListener("click", function () { connectDialog.close(); });
el("saveKey").addEventListener("click", function () {
  const value = el("apiKeyInput").value.trim();
  if (!value) {
    toast("Enter an OpenRouter key or continue in simulation mode.", "error");
    return;
  }
  state.apiKey = value;
  el("apiKeyInput").value = "";
  connectDialog.close();
  updateMode();
  updatePlan();
  toast("Live mode enabled for this page session. The key is not stored.", "success");
});
el("toggleKey").addEventListener("click", function () {
  const input = el("apiKeyInput");
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  el("toggleKey").textContent = visible ? "Hide" : "Show";
  el("toggleKey").setAttribute("aria-label", visible ? "Hide key" : "Show key");
});
connectDialog.addEventListener("click", function (event) {
  const bounds = connectDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) connectDialog.close();
});
el("clearActivity").addEventListener("click", function () {
  state.logs = [];
  renderStats();
  renderActivity();
  toast("Session activity cleared.", "success");
});

document.querySelectorAll(".nav-item").forEach(function (link) {
  link.addEventListener("click", function () {
    document.querySelectorAll(".nav-item").forEach(function (item) { item.classList.remove("active"); });
    link.classList.add("active");
  });
});

updateMode();
renderModelPool();
updatePlan();
renderStats();
renderActivity();
refreshCatalog(false);
