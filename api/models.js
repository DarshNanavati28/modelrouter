import { MODELS, CATALOG_SOURCE } from "../src/models.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}

export async function getCatalog() {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) throw new Error("catalog unavailable");
    const payload = await response.json();
    const liveMap = new Map((payload.data || []).map(function (item) { return [item.id, item]; }));

    const models = MODELS.map(function (model) {
      const current = liveMap.get(model.id);
      if (!current) return Object.assign({}, model, { catalogStatus: "snapshot" });
      const input = Number(current.pricing && current.pricing.prompt);
      const output = Number(current.pricing && current.pricing.completion);
      return Object.assign({}, model, {
        name: current.name ? current.name.replace(/^[^:]+:\s*/, "") : model.name,
        contextTokens: Number(current.context_length || model.contextTokens),
        inputPricePerMillion: Number.isFinite(input) ? input * 1000000 : model.inputPricePerMillion,
        outputPricePerMillion: Number.isFinite(output) ? output * 1000000 : model.outputPricePerMillion,
        catalogStatus: "live"
      });
    });

    return { models: models, source: "Live OpenRouter catalog", refreshedAt: new Date().toISOString() };
  } catch (error) {
    return {
      models: MODELS.map(function (model) { return Object.assign({}, model, { catalogStatus: "snapshot" }); }),
      source: CATALOG_SOURCE + " (live refresh unavailable)",
      refreshedAt: null
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
  const catalog = await getCatalog();
  return json(res, 200, catalog);
}
