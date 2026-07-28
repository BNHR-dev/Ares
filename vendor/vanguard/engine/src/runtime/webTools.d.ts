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
/**
 * Loopback reachability for services the runtime itself started.
 *
 * Supplied by the supervised-process registry, never by the model: the
 * allowance is derived from what Vanguard actually launched, so an agent can
 * check its own dev server without being able to ask for 127.0.0.1:22.
 */
export interface SupervisedLoopbackAllowance {
    allows(hostname: string, port: number): boolean;
}
export declare class PublicNetworkTargetPolicy implements NetworkTargetPolicy {
    private readonly loopback?;
    constructor(loopback?: SupervisedLoopbackAllowance | undefined);
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
