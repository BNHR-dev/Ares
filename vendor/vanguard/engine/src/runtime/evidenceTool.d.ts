import type { JournalPort, JsonValue, RunEvent, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
export interface EvidenceSource {
    readValidated(): Promise<readonly RunEvent[]>;
}
export declare class EvidenceReadTool implements ToolPort {
    private readonly journal;
    readonly name = "read_evidence";
    readonly definition: ToolDefinition;
    constructor(journal: EvidenceSource);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
/** Narrow structural check so a plain JournalPort can back the tool. */
export declare function isEvidenceSource(journal: JournalPort | EvidenceSource): journal is EvidenceSource;
