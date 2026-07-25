import type { UserChannelPort } from "../kernel/contracts.js";
/**
 * A live NDJSON control channel over stdin: {"type":"user_message","text":…}
 * queues steering (or answers a pending question); {"type":"cancel"} aborts.
 */
export declare class StdinUserChannel implements UserChannelPort {
    #private;
    constructor(onCancel: () => void);
    /** Releases stdin so the process can exit once the advance finishes. */
    close(): void;
    drain(): readonly string[];
    requeue(messages: readonly string[]): void;
    wait(signal: AbortSignal): Promise<string | undefined>;
}
/**
 * Ask the owner about a command outside the allowlist, over the same control
 * stream that carries steering: the question goes out as a public event the UI
 * renders, and the answer arrives as an ordinary user message.
 */
export declare function commandApprover(userChannel: UserChannelPort): (request: {
    command: string;
    args: readonly string[];
    cwd: string;
}, signal: AbortSignal) => Promise<"once" | "always" | "deny">;
/** Accepts the numbered menu or the words behind it; anything else re-asks. */
export declare function parseApproval(answer: string): "once" | "always" | "deny" | undefined;
