import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
import type { LoadedSkill } from "../extensions/skills.js";
export declare class SkillReadTool implements ToolPort {
    #private;
    readonly name = "read_skill";
    readonly definition: ToolDefinition;
    constructor(skills: readonly LoadedSkill[]);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
