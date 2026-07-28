import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
export interface NetworkTargetPolicy {
    assertAllowed(url: URL): Promise<void>;
}
export interface WebTransportOptions {
    readonly fetchImplementation?: typeof fetch;
    readonly targetPolicy?: NetworkTargetPolicy;
    readonly timeoutMs?: number;
}
/**
 * Default-deny network policy for model-selected URLs. HTTP(S) is allowed only
 * for public DNS targets on the default ports; loopback, private, link-local,
 * documentation, multicast, and unspecified addresses are rejected.
 */
export declare class PublicNetworkTargetPolicy implements NetworkTargetPolicy {
    assertAllowed(url: URL): Promise<void>;
}
export declare class WebFetchTool implements ToolPort {
    #private;
    readonly name = "fetch_url";
    readonly definition: ToolDefinition;
    constructor(options?: WebTransportOptions);
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
export declare class WebSearchTool implements ToolPort {
    #private;
    readonly name = "search_web";
    readonly definition: ToolDefinition;
    constructor(options?: WebTransportOptions & {
        readonly searchEndpoint?: string;
    });
    execute(input: JsonValue, context: ToolContext): Promise<ToolResult>;
}
