import { HttpModelAdapter, VANGUARD_PROVIDER_CONFIG_VERSION, createAnthropicModel, createConfiguredProviderModel, createDeepSeekModel, createOllamaModel, } from "../index.js";
function configuredReasoningEffort(options) {
    const value = options.reasoningEffort ?? process.env.VANGUARD_REASONING_EFFORT ?? "medium";
    if (value !== "low" && value !== "medium" && value !== "high" && value !== "max") {
        throw new Error("Reasoning effort must be low, medium, high, or max.");
    }
    return value;
}
function openaiReasoningEffort(options) {
    const value = configuredReasoningEffort(options);
    return value === "max" ? "high" : value;
}
function kimiReasoning(options) {
    return { thinking: "enabled", effort: configuredReasoningEffort(options) };
}
export function createModel(options, streamObserver) {
    const common = {
        model: options.model,
        timeoutMs: 600_000,
        maxAttempts: 4,
        ...(streamObserver === undefined ? {} : { streamObserver }),
    };
    if (options.auth === "oauth") {
        if (options.provider !== "openai" && options.provider !== "anthropic" && options.provider !== "kimi") {
            throw new Error("--auth oauth is available only for the openai, anthropic, and kimi providers.");
        }
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: options.provider,
            model: options.model,
            credential: { source: "oauth", provider: options.provider },
            ...(options.provider === "anthropic" ? { apiVersion: "2023-06-01" } : {}),
            ...(options.provider === "kimi" ? { reasoning: kimiReasoning(options) } : {}),
            ...(options.provider === "openai" ? { reasoning: { effort: openaiReasoningEffort(options) } } : {}),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    }
    if (options.credentialVariable !== undefined && options.provider !== "http") {
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: options.provider,
            model: options.model,
            credential: { source: "environment", variable: options.credentialVariable },
            ...(options.provider === "openai-compatible" ? { wire: "openai-chat-completions" } : {}),
            ...(options.provider === "anthropic" ? { apiVersion: "2023-06-01" } : {}),
            ...(options.provider === "kimi" ? { reasoning: kimiReasoning(options) } : {}),
            ...(options.provider === "openai" ? { reasoning: { effort: openaiReasoningEffort(options) } } : {}),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    }
    if (options.provider === "openai")
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: "openai",
            model: options.model,
            reasoning: { effort: openaiReasoningEffort(options) },
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    if (options.provider === "anthropic")
        return createAnthropicModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    if (options.provider === "deepseek")
        return createDeepSeekModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    if (options.provider === "kimi")
        return createConfiguredProviderModel({
            version: VANGUARD_PROVIDER_CONFIG_VERSION,
            provider: "kimi",
            model: options.model,
            reasoning: kimiReasoning(options),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        }, common);
    if (options.provider === "ollama")
        return createOllamaModel({ ...common, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    if (options.provider === "openai-compatible") {
        throw new Error("--credential-variable is required for the openai-compatible provider.");
    }
    if (options.endpoint === undefined)
        throw new Error("--endpoint is required for the http provider.");
    return new HttpModelAdapter({ endpoint: options.endpoint, timeoutMs: common.timeoutMs, maxAttempts: common.maxAttempts });
}
