import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCatalog,
  clearRouteCooldown,
  getClientForRoute,
  getRouteCooldown,
  invalidateRouteCache,
  isRouteInCooldown,
  markRouteCooldown,
  newRouteId,
  pickFallbackCandidates,
  prefixedId,
  resetAllCooldowns,
  saveRoutes,
  transportPlanForModel,
  vendorForRoute,
  SECRET_PREFIX,
} from "../src/routes";
import type { OmniRouteModel } from "../src/types";
import { secretStore, configValues, configUpdates, createMockContext } from "./vscode.mock";

function model(id: string, toolCalling?: boolean): OmniRouteModel {
  return {
    id,
    ...(toolCalling === undefined ? {} : { capabilities: { tool_calling: toolCalling } }),
  };
}

describe("newRouteId", () => {
  it("incrementa sobre ids route-N existentes", () => {
    expect(newRouteId([{ id: "route-1", name: "a", baseUrl: "x" }])).toBe("route-2");
  });
  it("salta ids no numéricos sin romper", () => {
    expect(newRouteId([{ id: "abc", name: "a", baseUrl: "x" }])).toBe("route-1");
  });
});

describe("prefixedId", () => {
  it("sanea el nombre y compone name · model", () => {
    expect(prefixedId("My Server", "r1", "openai/gpt-4o", new Set())).toBe("My Server · openai/gpt-4o");
  });
  it("limpia caracteres raros y usa routeId si el nombre queda vacío", () => {
    expect(prefixedId("a/b:c*", "r1", "kimi/k2", new Set())).toBe("abc · kimi/k2");
    expect(prefixedId("   ", "r1", "kimi/k2", new Set())).toBe("r1 · kimi/k2");
  });
  it("sufija #routeId en colisiones", () => {
    const taken = new Set(["My · openai/gpt-4o"]);
    expect(prefixedId("My", "r2", "openai/gpt-4o", taken)).toBe("My · openai/gpt-4o #r2");
  });
});

describe("buildCatalog", () => {
  it("une catálogos de varias rutas y etiqueta entrada con routeId/modelId", () => {
    const catalog = buildCatalog([
      { routeId: "r1", name: "A", models: [model("openai/gpt-4o")] },
      { routeId: "r2", name: "B", models: [model("kimi/k2")] },
    ]);
    expect(catalog).toEqual([
      { entry: { routeId: "r1", routeName: "A", modelId: "openai/gpt-4o", prefixedId: "A · openai/gpt-4o" }, model: model("openai/gpt-4o") },
      { entry: { routeId: "r2", routeName: "B", modelId: "kimi/k2", prefixedId: "B · kimi/k2" }, model: model("kimi/k2") },
    ]);
  });
  it("desambigua el mismo modelo id de dos rutas con nombres iguales", () => {
    const catalog = buildCatalog([
      { routeId: "r1", name: "Same", models: [model("openai/gpt-4o")] },
      { routeId: "r2", name: "Same", models: [model("openai/gpt-4o")] },
    ]);
    expect(catalog[0].entry.prefixedId).toBe("Same · openai/gpt-4o");
    expect(catalog[1].entry.prefixedId).toBe("Same · openai/gpt-4o #r2");
  });
  it("ignora id de modelo vacío", () => {
    const catalog = buildCatalog([{ routeId: "r1", name: "A", models: [{ id: "" }, model("x/y")] }]);
    expect(catalog.map((c) => c.entry.modelId)).toEqual(["x/y"]);
  });
});

describe("transportPlanForModel", () => {
  it("orders Responses before explicit Chat Completions or Messages compatibility surfaces", () => {
    expect(transportPlanForModel({ id: "mixed-chat", supported_endpoints: ["chat/completions", "responses"] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "mixed-messages", supported_endpoints: ["messages", "POST /v1/responses"] })).toEqual(["responses", "messages"]);
  });

  it.each([
    [" CHAT/COMPLETIONS "],
    ["POST ///v1//chat/completions/?stream=true#sse"],
    ["https://api.example.test/v1/chat/completions"],
  ])("selects Chat Completions for chat-only metadata %j", (endpoint) => {
    expect(transportPlanForModel({ id: "chat", supported_endpoints: [endpoint] })).toEqual(["chatCompletions"]);
  });

  it("selects Messages for Messages-only metadata", () => {
    expect(transportPlanForModel({ id: "messages", supported_endpoints: ["POST /v1/messages"] })).toEqual(["messages"]);
  });

  it("uses compatibility fallback for absent, empty, unknown, and deceptive metadata but none for legacy-only", () => {
    expect(transportPlanForModel(undefined)).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "empty", supported_endpoints: [] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "unknown", supported_endpoints: ["future/generate"] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "deceptive", supported_endpoints: ["chat/completions-preview"] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "legacy", supported_endpoints: ["completions"] })).toEqual([]);
  });
});

describe("pickFallbackCandidates", () => {
  const cat = buildCatalog([
    { routeId: "r1", name: "A", models: [model("openai/gpt-4o", true), model("openai/gpt-4o-mini", false)] },
    { routeId: "r2", name: "B", models: [model("openai/gpt-4o"), model("kimi/k2")] },
  ]);
  const gpt4o = cat.find((c) => c.entry.prefixedId === "A · openai/gpt-4o")!.entry;

  it("pone primero el mismo modelo en otra ruta, luego familia en la misma ruta", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false);
    expect(got[0]).toEqual({ routeId: "r2", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] });
    // las tool_calling:false no importan sin tools; familia misma ruta → gpt-4o-mini
    expect(got[1]).toEqual({ routeId: "r1", modelId: "openai/gpt-4o-mini", transportPlan: ["responses", "chatCompletions"] });
  });
  it("excluye modelos sin tool_calling cuando se requieren tools", () => {
    const got = pickFallbackCandidates(gpt4o, cat, true);
    expect(got.every((c) => c.modelId !== "openai/gpt-4o-mini")).toBe(true);
  });
  it("respeta el límite max y excluye el primario", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "full", 1);
    expect(got).toHaveLength(1);
  });
  it("mode none devuelve lista vacía", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "none");
    expect(got).toEqual([]);
  });
  it("mode sameModel solo reintenta el mismo modelo en otra ruta", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "sameModel");
    expect(got).toEqual([{ routeId: "r2", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] }]);
  });
  it("mode sameFamily excluye modelos de otra ruta que no son el mismo modelo", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "sameFamily");
    // mismo modelo en r2 + familia misma ruta (gpt-4o-mini), pero no kimi/k2 (otra ruta, otra familia)
    expect(got.map((c) => c.modelId)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
  });
  it("mode full alcanza cualquier modelo compatible en otros servidores", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "full");
    // mismo modelo en r2, luego familia misma ruta (gpt-4o-mini), luego kimi/k2
    expect(got.map((c) => c.modelId)).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "kimi/k2",
    ]);
  });
});

describe("vendorForRoute", () => {
  it("genera omniroute-NOMBRE para servidor unico", () => {
    const routes = [{ id: "r1", name: "Ashburn" }];
    expect(vendorForRoute(routes[0], routes)).toBe("omniroute-Ashburn");
  });

  it("agrega el routeId si hay colision de nombres de servidor", () => {
    const routes = [
      { id: "r1", name: "Ashburn" },
      { id: "r2", name: "Ashburn" },
    ];
    expect(vendorForRoute(routes[0], routes)).toBe("omniroute-Ashburn-r1");
    expect(vendorForRoute(routes[1], routes)).toBe("omniroute-Ashburn-r2");
  });
});

describe("saveRoutes", () => {
  beforeEach(() => {
    secretStore.clear();
    configUpdates.length = 0;
    for (const k of Object.keys(configValues)) delete configValues[k];
  });

  function seedPrior(routes: Array<{ id: string; name: string; baseUrl: string }>) {
    configValues["omnicopilot"] = { ...(configValues["omnicopilot"] ?? {}), routes };
  }

  it("mantiene el secreto cuando una ruta existente se guarda sin apiKey", async () => {
    seedPrior([{ id: "route-1", name: "A", baseUrl: "http://a/v1" }]);
    secretStore.set(SECRET_PREFIX + "route-1", "viejakey");
    // El panel envía apiKey:"" si el usuario no la reescribe → no debe borrarse.
    await saveRoutes(createMockContext() as never, [{ id: "route-1", name: "A", baseUrl: "http://a/v1" }]);
    expect(secretStore.get(SECRET_PREFIX + "route-1")).toBe("viejakey");
  });

  it("borra el secreto de rutas eliminadas de la lista", async () => {
    seedPrior([
      { id: "route-1", name: "A", baseUrl: "http://a/v1" },
      { id: "route-2", name: "B", baseUrl: "http://b/v1" },
    ]);
    secretStore.set(SECRET_PREFIX + "route-1", "k1");
    secretStore.set(SECRET_PREFIX + "route-2", "k2");
    await saveRoutes(createMockContext() as never, [{ id: "route-1", name: "A", baseUrl: "http://a/v1" }]);
    expect(secretStore.has(SECRET_PREFIX + "route-2")).toBe(false);
    expect(secretStore.has(SECRET_PREFIX + "route-1")).toBe(true);
  });

  it("guarda la apiKey de rutas con key y mantiene la de las que siguen", async () => {
    secretStore.set(SECRET_PREFIX + "route-1", "k1");
    await saveRoutes(createMockContext() as never, [
      { id: "route-1", name: "A", baseUrl: "http://a/v1" },
      { id: "route-2", name: "B", baseUrl: "http://b/v1", apiKey: "nueva" },
    ]);
    expect(secretStore.get(SECRET_PREFIX + "route-1")).toBe("k1");
    expect(secretStore.get(SECRET_PREFIX + "route-2")).toBe("nueva");
  });

  it("persiste la config con urls normalizadas", async () => {
    await saveRoutes(createMockContext() as never, [
      { id: "route-1", name: "A", baseUrl: "http://a/v1/", apiKey: "x" },
    ]);
    const saved = configUpdates.find((u) => u.key === "routes")?.value as unknown[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "route-1", baseUrl: "http://a/v1" });
  });
});

describe("getClientForRoute", () => {
  beforeEach(() => {
    invalidateRouteCache();
  });

  it("reutiliza el cliente si las opciones coinciden", () => {
    const route = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-1" };
    const c1 = getClientForRoute(route, undefined, 5000);
    const c2 = getClientForRoute(route, undefined, 5000);
    expect(c1).toBe(c2);
  });

  it("crea un nuevo cliente si cambia el timeout de primer byte", () => {
    const route = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-1" };
    const c1 = getClientForRoute(route, undefined, 5000);
    const c2 = getClientForRoute(route, undefined, 10000);
    expect(c1).not.toBe(c2);
    expect(c2.options.streamFirstByteTimeoutMs).toBe(10000);
  });

  it("crea un nuevo cliente si cambia la apiKey o baseUrl", () => {
    const route1 = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-1" };
    const route2 = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-2" };
    const c1 = getClientForRoute(route1);
    const c2 = getClientForRoute(route2);
    expect(c1).not.toBe(c2);
    expect(c2.options.apiKey).toBe("key-2");
  });

  it("limpia el pool al llamar invalidateRouteCache", () => {
    const route = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1" };
    const c1 = getClientForRoute(route);
    invalidateRouteCache();
    const c2 = getClientForRoute(route);
    expect(c1).not.toBe(c2);
  });
});

describe("Route Cooldowns", () => {
  beforeEach(() => {
    resetAllCooldowns();
  });

  it("marks route in cooldown and respects duration", () => {
    markRouteCooldown("route-1", 10_000, 429, "Throttled");
    expect(isRouteInCooldown("route-1")).toBe(true);

    const info = getRouteCooldown("route-1");
    expect(info).toBeDefined();
    expect(info?.routeId).toBe("route-1");
    expect(info?.status).toBe(429);
    expect(info?.reason).toBe("Throttled");
    expect(info?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("expires cooldown when time has elapsed", () => {
    vi.useFakeTimers();
    try {
      markRouteCooldown("route-1", 5_000, 503, "Service unavailable");
      expect(isRouteInCooldown("route-1")).toBe(true);

      vi.advanceTimersByTime(5_001);
      expect(isRouteInCooldown("route-1")).toBe(false);
      expect(getRouteCooldown("route-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears cooldown on explicit clear or cache invalidation", () => {
    markRouteCooldown("route-1", 10_000, 429);
    markRouteCooldown("route-2", 10_000, 503);

    clearRouteCooldown("route-1");
    expect(isRouteInCooldown("route-1")).toBe(false);
    expect(isRouteInCooldown("route-2")).toBe(true);

    invalidateRouteCache();
    expect(isRouteInCooldown("route-2")).toBe(false);
  });
});