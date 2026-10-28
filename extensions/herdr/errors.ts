/** A failure that should reach the model as a tool error, with a stable machine-readable code. */
export class ToolError extends Error {
	code: string;
	detail?: unknown;

	constructor(code: string, message: string, detail?: unknown) {
		super(message);
		this.name = "ToolError";
		this.code = code;
		this.detail = detail;
	}
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
