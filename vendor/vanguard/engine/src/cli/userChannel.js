import { createInterface } from "node:readline";
import { streamPublicEvent } from "./scorecard.js";
export class StdinUserChannel {
    #queue = [];
    #waiters = [];
    #reader;
    #closed = false;
    constructor(onCancel) {
        const reader = createInterface({ input: process.stdin });
        this.#reader = reader;
        reader.on("line", (line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                return;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.type === "user_message" && typeof parsed.text === "string" && parsed.text.length > 0) {
                    const waiter = this.#waiters.shift();
                    if (waiter !== undefined)
                        waiter(parsed.text);
                    else
                        this.#queue.push(parsed.text);
                }
                else if (parsed.type === "cancel") {
                    onCancel();
                }
            }
            catch {
            }
        });
        reader.on("close", () => {
            this.#closed = true;
            for (const waiter of this.#waiters.splice(0))
                waiter(undefined);
        });
    }
    close() {
        this.#closed = true;
        this.#reader.close();
        process.stdin.pause();
        process.stdin.unref?.();
        for (const waiter of this.#waiters.splice(0))
            waiter(undefined);
    }
    drain() {
        return this.#queue.splice(0);
    }
    requeue(messages) {
        if (messages.length === 0)
            return;
        this.#queue.unshift(...messages);
        while (this.#queue.length > 0 && this.#waiters.length > 0) {
            const waiter = this.#waiters.shift();
            waiter(this.#queue.shift());
        }
    }
    wait(signal) {
        const queued = this.#queue.shift();
        if (queued !== undefined)
            return Promise.resolve(queued);
        if (this.#closed || signal.aborted)
            return Promise.resolve(undefined);
        return new Promise((resolve) => {
            const waiter = (message) => {
                signal.removeEventListener("abort", onAbort);
                resolve(message);
            };
            const onAbort = () => {
                const index = this.#waiters.indexOf(waiter);
                if (index >= 0)
                    this.#waiters.splice(index, 1);
                resolve(undefined);
            };
            this.#waiters.push(waiter);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }
}
export function commandApprover(userChannel) {
    return async (request, signal) => {
        const line = [request.command, ...request.args].join(" ");
        const ask = (title) => {
            streamPublicEvent({
                type: "approval.requested",
                agentId: "main",
                status: "info",
                title,
                detail: line,
                message: line,
            });
        };
        const deferred = [...userChannel.drain()];
        const finish = (decision) => {
            userChannel.requeue?.(deferred);
            return decision;
        };
        ask("Approval needed");
        for (;;) {
            const answer = await userChannel.wait(signal);
            if (answer === undefined)
                return finish("deny");
            const decision = parseApproval(answer);
            if (decision !== undefined)
                return finish(decision);
            deferred.push(answer);
            ask("Approval needed — answer 1, 2, or 3");
        }
    };
}
export function parseApproval(answer) {
    const value = answer.trim().toLowerCase();
    if (value === "1" || value === "y" || value === "yes" || value === "once")
        return "once";
    if (value === "2" || value === "a" || value === "always")
        return "always";
    if (value === "3" || value === "n" || value === "no" || value === "deny")
        return "deny";
    return undefined;
}
