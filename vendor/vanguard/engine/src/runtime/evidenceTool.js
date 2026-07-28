import { objectInput, stringField } from "./input.js";
const EVIDENCE_ID = /^evidence:[1-9][0-9]*:[1-9][0-9]*$/u;
const DEFAULT_MAX_BYTES = 32 * 1024;
const MAX_BYTES = 256 * 1024;
export class EvidenceReadTool {
    journal;
    name = "read_evidence";
    definition = {
        name: this.name,
        description: "Retrieve the full recorded output of an earlier tool observation by its evidenceId, including exchanges "
            + "already compacted out of the conversation. Use this instead of re-running a read or command whose result "
            + "you have already seen but no longer have in full.",
        inputSchema: {
            type: "object",
            properties: {
                evidenceId: {
                    type: "string",
                    description: "The evidenceId from a historical tool exchange, e.g. 'evidence:42:1'.",
                },
                maxBytes: {
                    type: "integer",
                    minimum: 1_024,
                    maximum: MAX_BYTES,
                    description: `Maximum returned output bytes; defaults to ${DEFAULT_MAX_BYTES}.`,
                },
                offset: {
                    type: "integer",
                    minimum: 0,
                    description: "Byte offset into the recorded output, for paging a large result.",
                },
            },
            required: ["evidenceId"],
            additionalProperties: false,
        },
        effect: "observe",
    };
    constructor(journal) {
        this.journal = journal;
    }
    async execute(input, _context) {
        try {
            const fields = objectInput(input);
            const evidenceId = stringField(fields, "evidenceId").trim();
            if (!EVIDENCE_ID.test(evidenceId)) {
                return { ok: false, output: { error: "evidenceId must look like 'evidence:<sequence>:<index>'." } };
            }
            const maxBytes = integerField(fields, "maxBytes", 1_024, MAX_BYTES) ?? DEFAULT_MAX_BYTES;
            const offset = integerField(fields, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
            const events = await this.journal.readValidated();
            const match = findEvidence(events, evidenceId);
            if (match === undefined) {
                return {
                    ok: false,
                    output: {
                        error: `No journaled observation carries evidenceId '${evidenceId}'.`,
                        hint: "Evidence ids appear on historical tool exchanges in the conversation; take one from there.",
                    },
                };
            }
            const serialized = match.output === undefined ? "" : stringify(match.output);
            const totalBytes = Buffer.byteLength(serialized);
            if (offset > totalBytes) {
                return { ok: false, output: { error: `offset ${offset} is past the recorded output (${totalBytes} bytes).` } };
            }
            const slice = Buffer.from(serialized).subarray(offset, offset + maxBytes);
            const nextOffset = offset + slice.byteLength;
            return {
                ok: true,
                output: {
                    evidenceId,
                    tool: match.tool,
                    ok: match.ok,
                    totalBytes,
                    offset,
                    returnedBytes: slice.byteLength,
                    truncated: nextOffset < totalBytes,
                    ...(nextOffset < totalBytes ? { nextOffset } : {}),
                    ...(match.failureCode === undefined ? {} : { failureCode: match.failureCode }),
                    output: slice.toString("utf8"),
                },
            };
        }
        catch (error) {
            return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
        }
    }
}
function findEvidence(events, evidenceId) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type !== "tool.completed" && event.type !== "tool.failed")
            continue;
        const data = record(event.data);
        if (data?.evidenceId !== evidenceId)
            continue;
        return {
            tool: typeof data.tool === "string" ? data.tool : "unknown",
            ok: data.ok === true,
            output: data.output,
            failureCode: typeof record(data.failure)?.code === "string" ? String(record(data.failure).code) : undefined,
        };
    }
    return undefined;
}
function stringify(value) {
    return typeof value === "string" ? value : JSON.stringify(value, null, 1) ?? String(value);
}
function integerField(input, name, minimum, maximum) {
    const value = input[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`Field '${name}' must be an integer from ${minimum} to ${maximum}.`);
    }
    return value;
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
export function isEvidenceSource(journal) {
    return typeof journal.readValidated === "function";
}
