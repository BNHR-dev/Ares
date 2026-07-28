import { objectInput, stringField } from "./input.js";
const MAX_BODY_BYTES = 128 * 1024;
export class SkillReadTool {
    name = "read_skill";
    definition;
    #skills;
    constructor(skills) {
        this.#skills = new Map(skills.map((skill) => [skill.metadata.name, skill]));
        const names = [...this.#skills.keys()];
        this.definition = {
            name: this.name,
            description: "Read the full instructions of a workspace skill by name. The task lists each skill's name and summary; "
                + "load a body only when it is relevant to the work at hand."
                + (names.length === 0 ? "" : ` Available: ${names.join(", ")}.`),
            inputSchema: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "The skill name exactly as advertised in the task.",
                        ...(names.length === 0 ? {} : { enum: names }),
                    },
                },
                required: ["name"],
                additionalProperties: false,
            },
            effect: "observe",
        };
    }
    async execute(input, _context) {
        try {
            const name = stringField(objectInput(input), "name").trim();
            const skill = this.#skills.get(name);
            if (skill === undefined) {
                return {
                    ok: false,
                    output: {
                        error: `No workspace skill named '${name}'.`,
                        available: [...this.#skills.keys()],
                    },
                };
            }
            const instructions = skill.instructions.length > MAX_BODY_BYTES
                ? skill.instructions.slice(0, MAX_BODY_BYTES)
                : skill.instructions;
            return {
                ok: true,
                output: {
                    name: skill.metadata.name,
                    description: skill.metadata.description,
                    ...(skill.metadata.version === undefined ? {} : { version: skill.metadata.version }),
                    truncated: instructions.length < skill.instructions.length,
                    instructions,
                },
            };
        }
        catch (error) {
            return { ok: false, output: { error: error instanceof Error ? error.message : String(error) } };
        }
    }
}
