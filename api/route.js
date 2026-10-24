import { MODELS } from "../src/models.js";
import { evaluateRequest, priceFor } from "../src/engine.js";
import { getCatalog } from "./models.js";

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}

function validNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getHeader(req, name) {
  if (req.headers && typeof req.headers.get === "function") return req.headers.get(name) || "";
  const headers = req.headers || {};
  return headers[name.toLowerCase()] || headers[name] || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  const body = req.body || {};
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "Add a prompt before routing." });
  if (prompt.length > 20000) return json(res, 413, { error: "Prompt is too long. Keep it under 20,000 characters." });

  const authorization = getHeader(req, "authorization");
  const apiKey = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!apiKey) return json(res, 401, { error: "Add an OpenRouter key to use live inference." });

  const request = body.constraints || {};
  const overrides = body.modelOverrides || {};
  const catalog = await getCatalog();
  const currentById = new Map(catalog.models.map(function (model) { return [model.id, model]; }));
  const models = MODELS.map(function (model) {
    const current = currentById.get(model.id) || model;
    const override = overrides[model.id] || {};
    return Object.assign({}, current, {
      available: override.available !== false,
      latencyMs: validNumber(override.latencyMs, model.latencyMs)
    });
  });

  const plan = evaluateRequest({
    prompt: prompt,
    minCapability: request.minCapability,
    requiredContextTokens: request.requiredContextTokens,
    maxLatencyMs: request.maxLatencyMs,
    maxCostUsd: request.maxCostUsd,
    maxOutputTokens: request.maxOutputTokens,
    preference: request.preference
  }, models, Object.fromEntries(models.map(function (model) {
    return [model.id, { available: model.available, latencyMs: model.latencyMs }];
  })));

  if (!plan.winner) {
    return json(res, 422, {
      error: "No model meets every hard constraint. The request was not sent.",
      plan: plan,
      attempts: []
    });
  }

  const startedAt = Date.now();
  let reservedSpend = 0;
  const attempts = [];

  for (const candidate of plan.eligible) {
    const elapsedBefore = Date.now() - startedAt;
    const remainingLatency = plan.maxLatencyMs - elapsedBefore;
    const reservedCost = candidate.costEstimate.total;

    if (candidate.measuredLatencyMs > remainingLatency) {
      attempts.push({
        modelId: candidate.id,
        status: "skipped",
        reason: "The remaining end-to-end latency budget is too short for this model's p95 estimate."
      });
      continue;
    }
    if (reservedSpend + reservedCost > plan.maxCostUsd) {
      attempts.push({
        modelId: candidate.id,
        status: "skipped",
        reason: "The remaining cost budget cannot safely cover another full attempt."
      });
      continue;
    }

    const attemptStarted = Date.now();
    const timeoutMs = Math.max(1, Math.min(remainingLatency, candidate.measuredLatencyMs));
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://modelrouter.vercel.app",
          "X-Title": "ModelRouter"
        },
        body: JSON.stringify({
          model: candidate.id,
          messages: [{ role: "user", content: prompt }],
          max_tokens: plan.outputTokens,
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const attemptLatency = Date.now() - attemptStarted;

      if (!response.ok) {
        let providerMessage = "Provider returned HTTP " + response.status + ".";
        try {
          const providerBody = await response.json();
          if (providerBody && providerBody.error && providerBody.error.message) {
            providerMessage = String(providerBody.error.message).slice(0, 240);
          }
        } catch (error) {
          providerMessage = "Provider returned HTTP " + response.status + ".";
        }
        reservedSpend += reservedCost;
        attempts.push({
          modelId: candidate.id,
          status: "failed",
          latencyMs: attemptLatency,
          reservedCostUsd: reservedCost,
          reason: providerMessage
        });
        continue;
      }

      const payload = await response.json();
      const usage = payload.usage || {};
      const actualCost = usage.cost != null && Number.isFinite(Number(usage.cost))
        ? Number(usage.cost)
        : priceFor(candidate, Number(usage.prompt_tokens || plan.inputTokens), Number(usage.completion_tokens || plan.outputTokens)).total;
      const elapsed = Date.now() - startedAt;

      if (actualCost + reservedSpend > plan.maxCostUsd) {
        reservedSpend += actualCost;
        attempts.push({
          modelId: candidate.id,
          status: "rejected",
          latencyMs: attemptLatency,
          costUsd: actualCost,
          reason: "Provider usage exceeded the remaining hard cost budget; response withheld."
        });
        return json(res, 502, {
          error: "The provider's reported usage exceeded the remaining hard cost budget. The response was withheld and no fallback was attempted.",
          attempts: attempts,
          totalLatencyMs: elapsed,
          totalCostUsd: reservedSpend
        });
      }

      if (elapsed > plan.maxLatencyMs) {
        reservedSpend += actualCost;
        attempts.push({
          modelId: candidate.id,
          status: "rejected",
          latencyMs: attemptLatency,
          costUsd: actualCost,
          reason: "Response arrived after the end-to-end latency budget; response withheld."
        });
        return json(res, 504, {
          error: "The response arrived after the hard latency budget and was withheld.",
          attempts: attempts,
          totalLatencyMs: elapsed,
          totalCostUsd: reservedSpend
        });
      }

      reservedSpend += actualCost;
      attempts.push({
        modelId: candidate.id,
        status: "selected",
        latencyMs: attemptLatency,
        costUsd: actualCost,
        reason: attempts.length ? "Constraint-valid failover succeeded." : "Lowest-cost eligible model returned within budget."
      });

      return json(res, 200, {
        ok: true,
        model: candidate,
        text: payload.choices && payload.choices[0] && payload.choices[0].message
          ? payload.choices[0].message.content
          : "",
        usage: usage,
        costUsd: reservedSpend,
        latencyMs: elapsed,
        attempts: attempts,
        plan: {
          maxLatencyMs: plan.maxLatencyMs,
          maxCostUsd: plan.maxCostUsd,
          requiredCapability: plan.requiredCapability,
          requiredContextTokens: plan.requiredContextTokens,
          inputTokens: plan.inputTokens,
          maxOutputTokens: plan.outputTokens
        }
      });
    } catch (error) {
      const attemptLatency = Date.now() - attemptStarted;
      reservedSpend += reservedCost;
      attempts.push({
        modelId: candidate.id,
        status: "failed",
        latencyMs: attemptLatency,
        reservedCostUsd: reservedCost,
        reason: error && error.name === "TimeoutError" ? "Model exceeded its latency allowance." : "Connection failed before a valid response."
      });
    }
  }

  const totalLatency = Date.now() - startedAt;
  return json(res, totalLatency >= plan.maxLatencyMs ? 504 : 503, {
    error: "All safe attempts failed or no constraint-valid fallback fit the remaining budgets. The request was not retried with relaxed limits.",
    attempts: attempts,
    totalLatencyMs: totalLatency,
    totalCostUsd: reservedSpend,
    plan: {
      maxLatencyMs: plan.maxLatencyMs,
      maxCostUsd: plan.maxCostUsd,
      requiredCapability: plan.requiredCapability,
      requiredContextTokens: plan.requiredContextTokens
    }
  });
}
