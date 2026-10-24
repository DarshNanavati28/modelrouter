export const CONTEXT_OPTIONS = [
  { label: "8K", value: 8192 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
  { label: "256K", value: 262144 },
  { label: "1M", value: 1048576 }
];

export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

export function estimateComplexity(prompt) {
  const value = String(prompt || "").trim();
  const lower = value.toLowerCase();
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  let level = 1;
  const cues = [];

  if (wordCount > 18 || value.length > 120) {
    level += 1;
    cues.push("longer prompt");
  }
  if (/\b(compare|evaluate|trade-?offs?|prioriti[sz]e|recommend|rank|critique|root cause|analy[sz]e)\b/i.test(value)) {
    level += 1;
    cues.push("analysis or comparison");
  }
  if (/\b(contract|clause|legal|compliance|policy|medical|diagnos|financial|security|architecture|migration|incident|regulation)\b/i.test(value)) {
    level += 1;
    cues.push("specialized domain");
  }
  if (/\b(code|debug|refactor|implement|algorithm|proof|derive|multi-step|step by step|edge case)\b/i.test(value)) {
    level += 1;
    cues.push("technical or multi-step work");
  }
  if (wordCount > 180 || value.length > 1400 || (lower.match(/\b(and|also|then|while|whereas)\b/g) || []).length > 7) {
    level += 1;
    cues.push("large or compound task");
  }

  level = Math.min(5, level);
  const confidence = value.length < 12 ? "low" : (cues.length === 0 || value.length > 180 ? "medium" : "high");
  const safeLevel = Math.min(5, level + (confidence === "low" ? 1 : 0));
  return {
    level: safeLevel,
    rawLevel: level,
    confidence: confidence,
    cues: cues,
    reason: cues.length ? cues.join(", ") : (confidence === "low" ? "request intent is unclear" : "short, direct task")
  };
}

export function priceFor(model, inputTokens, outputTokens) {
  const input = Number(model.inputPricePerMillion || 0) * inputTokens / 1000000;
  const output = Number(model.outputPricePerMillion || 0) * outputTokens / 1000000;
  return {
    input: input,
    output: output,
    total: input + output
  };
}

function clampNumber(value, minimum, maximum, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(maximum, Math.max(minimum, n));
}

export function evaluateRequest(request, models, overrides) {
  const prompt = String(request.prompt || "");
  const inputTokens = estimateTokens(prompt);
  const outputTokens = Math.round(clampNumber(request.maxOutputTokens, 32, 2048, 256));
  const requiredContext = Math.max(
    Math.round(clampNumber(request.requiredContextTokens, 1, 1048576, 8192)),
    inputTokens + outputTokens
  );
  const complexity = estimateComplexity(prompt);
  const requestedCapability = Math.round(clampNumber(request.minCapability, 1, 5, 1));
  const requiredCapability = Math.max(requestedCapability, complexity.level);
  const maxLatencyMs = Math.round(clampNumber(request.maxLatencyMs, 50, 120000, 1500));
  const maxCostUsd = clampNumber(request.maxCostUsd, 0, 100, 0.003);
  const preference = ["cost", "latency", "quality"].includes(request.preference) ? request.preference : "cost";
  const overrideMap = overrides || {};

  const evaluated = models.map(function (model) {
    const override = overrideMap[model.id] || {};
    const available = override.available !== false;
    const latencyMs = Math.round(clampNumber(override.latencyMs, 1, 120000, model.latencyMs));
    const cost = priceFor(model, inputTokens, outputTokens);
    const reasons = [];

    if (!available) reasons.push("Endpoint marked offline");
    if (latencyMs > maxLatencyMs) reasons.push("P95 latency " + latencyMs + " ms exceeds " + maxLatencyMs + " ms");
    if (cost.total > maxCostUsd) reasons.push("Estimated cost " + cost.total.toFixed(6) + " exceeds $" + maxCostUsd.toFixed(4));
    if (model.quality < requiredCapability) reasons.push("Capability " + model.quality + " is below required " + requiredCapability);
    if (model.contextTokens < requiredContext) reasons.push("Context " + model.contextTokens.toLocaleString() + " is below required " + requiredContext.toLocaleString());

    return Object.assign({}, model, {
      available: available,
      measuredLatencyMs: latencyMs,
      costEstimate: cost,
      eligible: reasons.length === 0,
      reasons: reasons
    });
  });

  const eligible = evaluated.filter(function (model) { return model.eligible; });
  const byCost = function (a, b) { return a.costEstimate.total - b.costEstimate.total || a.measuredLatencyMs - b.measuredLatencyMs || b.quality - a.quality; };
  const byLatency = function (a, b) { return a.measuredLatencyMs - b.measuredLatencyMs || byCost(a, b); };
  const byQuality = function (a, b) { return b.quality - a.quality || byCost(a, b); };
  const comparator = preference === "latency" ? byLatency : (preference === "quality" ? byQuality : byCost);
  eligible.sort(comparator);

  return {
    prompt: prompt,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    requiredContextTokens: requiredContext,
    requiredCapability: requiredCapability,
    requestedCapability: requestedCapability,
    complexity: complexity,
    maxLatencyMs: maxLatencyMs,
    maxCostUsd: maxCostUsd,
    preference: preference,
    models: evaluated,
    eligible: eligible,
    winner: eligible[0] || null
  };
}

export function formatUsd(amount, digits) {
  const value = Number(amount || 0);
  if (value === 0) return "$0.0000";
  if (value < 0.0001) return "<$0.0001";
  return "$" + value.toFixed(digits === undefined ? 4 : digits);
}
