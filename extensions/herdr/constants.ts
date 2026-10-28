// Shared lists of CLI values. Keeping them as const arrays lets TypeBox build the parameter
// schemas and lets the wrappers validate without repeating the strings.
export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export const READ_SOURCES = ["visible", "recent", "recent-unwrapped", "detection"] as const;
export const REPORT_STATES = ["idle", "working", "blocked", "done", "error"] as const;
export const BLOCKED_KINDS = ["question", "permission", "auth"] as const;
