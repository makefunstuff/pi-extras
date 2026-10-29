// gpu-swap settings, free of pi so the unit tests can call them: which backends share the GPUs,
// which pi provider needs which backend, and the timeouts.
//
// Off by default: nothing is checked, started or stopped until PI_GPU_SWAP=on or the config file
// says enabled. No hostname or address is built in: health URLs come from the config file or from
// PI_GPU_SWAP_HEALTH_<BACKEND>.
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface BackendConfig {
	/** systemd unit that runs it (started and stopped with `systemctl`). */
	unit?: string;
	/** Name shown in the status line, e.g. "Strata". */
	label: string;
	/** URL that answers 2xx once the backend serves requests. Without one, "unit active" is ready. */
	health?: string;
	/** pi provider whose API key is sent with the health check (default: the first provider mapped to this backend). */
	authProvider?: string;
	/** Rough load time, only shown in the status line ("~90 s"). */
	loadSeconds?: number;
	/** Command that starts it, as an argument vector (default: systemctl start <unit>), e.g. ["local-ai-mode", "strata"]. */
	start?: string[];
	/** Command that stops it (default: systemctl stop <unit>). */
	stop?: string[];
}

export interface GpuSwapConfig {
	enabled: boolean;
	/** The backend that holds the GPUs when no session needs another one. */
	defaultBackend: string;
	backends: Record<string, BackendConfig>;
	/** pi provider name -> backend name. Providers not listed are left alone. */
	providers: Record<string, string>;
	/** How long a started backend may take to answer its health URL. */
	readyTimeoutMs: number;
	/** How long a request waits for another session's lease before it fails. */
	leaseWaitMs: number;
	/** A session's claim on a backend lapses after this long without a request. */
	idleMs: number;
	/** How often a live session refreshes its entry in the lease (and checks for switch-back). */
	heartbeatMs: number;
	/** An entry whose heartbeat is older than this is dropped. */
	staleMs: number;
	/** Health / lease poll interval while waiting. */
	pollMs: number;
	/** The lease file every pi session on this machine shares. */
	leaseFile: string;
	/** The systemctl binary. */
	systemctl: string;
}

export const DEFAULT_BACKENDS: Record<string, BackendConfig> = {
	router: { unit: "local-ai-router.service", label: "llama.cpp router", loadSeconds: 10 },
	strata: { unit: "strata.service", label: "Strata", loadSeconds: 90 },
};

export const DEFAULT_PROVIDERS: Record<string, string> = { strata: "strata", "llama.cpp": "router" };

function runtimeDir(env: NodeJS.ProcessEnv): string {
	return env.XDG_RUNTIME_DIR || tmpdir();
}

export const DEFAULTS = (env: NodeJS.ProcessEnv = process.env): GpuSwapConfig => ({
	enabled: false,
	defaultBackend: "router",
	backends: structuredClone(DEFAULT_BACKENDS),
	providers: { ...DEFAULT_PROVIDERS },
	readyTimeoutMs: 300_000,
	leaseWaitMs: 600_000,
	idleMs: 600_000,
	heartbeatMs: 15_000,
	staleMs: 60_000,
	pollMs: 1_000,
	leaseFile: join(runtimeDir(env), "pi-gpu-swap", "lease.json"),
	systemctl: "systemctl",
});

function agentDir(env: NodeJS.ProcessEnv): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}

/** Path of the optional config file: <agent dir>/gpu-swap.json. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_GPU_SWAP_CONFIG ?? join(agentDir(env), "gpu-swap.json");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onOff = (v: string) => !/^(0|false|off|no)$/i.test(v);
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const argv = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s) ? (v as string[]) : undefined;

function seconds(v: unknown, fallbackMs: number): number {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : fallbackMs;
}

function backend(name: string, raw: unknown, base: BackendConfig | undefined, warn: (m: string) => void): BackendConfig | undefined {
	if (!isObject(raw)) {
		warn(`gpu-swap: backend "${name}" is not an object; ignored`);
		return base;
	}
	const merged: BackendConfig = { ...(base ?? { label: name }) };
	if (typeof raw.unit === "string" && raw.unit) merged.unit = raw.unit;
	if (typeof raw.label === "string" && raw.label) merged.label = raw.label;
	if (typeof raw.health === "string" && raw.health) merged.health = raw.health;
	if (typeof raw.authProvider === "string" && raw.authProvider) merged.authProvider = raw.authProvider;
	if (typeof raw.loadSeconds === "number" && raw.loadSeconds > 0) merged.loadSeconds = raw.loadSeconds;
	if (argv(raw.start)) merged.start = argv(raw.start);
	if (argv(raw.stop)) merged.stop = argv(raw.stop);
	if (!merged.unit && !merged.start) {
		warn(`gpu-swap: backend "${name}" has neither a unit nor a start command; ignored`);
		return undefined;
	}
	return merged;
}

/** Defaults, then the config file, then PI_GPU_SWAP_* environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = () => {}): GpuSwapConfig {
	const config = DEFAULTS(env);
	let file: Record<string, unknown> = {};
	const path = configPath(env);
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (isObject(parsed)) file = parsed;
			else warn(`gpu-swap: ignoring ${path}: not a JSON object`);
		} catch (e) {
			warn(`gpu-swap: ignoring ${path}: ${(e as Error).message}`);
		}
	}
	if (typeof file.enabled === "boolean") config.enabled = file.enabled;
	if (env.PI_GPU_SWAP !== undefined) config.enabled = onOff(env.PI_GPU_SWAP);

	if (isObject(file.backends)) {
		for (const [name, raw] of Object.entries(file.backends)) {
			const b = raw === null ? undefined : backend(name, raw, config.backends[name], warn);
			if (b) config.backends[name] = b;
			else delete config.backends[name];
		}
	}
	if (isObject(file.providers)) {
		for (const [provider, name] of Object.entries(file.providers)) {
			if (name === null) delete config.providers[provider];
			else if (typeof name === "string") config.providers[provider] = name;
		}
	}
	if (typeof file.defaultBackend === "string") config.defaultBackend = file.defaultBackend;
	for (const [name, b] of Object.entries(config.backends)) {
		const health = env[`PI_GPU_SWAP_HEALTH_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
		if (health) b.health = health;
	}
	for (const [provider, name] of Object.entries(config.providers)) {
		if (!config.backends[name]) {
			warn(`gpu-swap: provider "${provider}" maps to unknown backend "${name}"; ignored`);
			delete config.providers[provider];
		}
	}
	if (!config.backends[config.defaultBackend]) {
		warn(`gpu-swap: default backend "${config.defaultBackend}" is not configured; switch-back is off`);
	}

	config.readyTimeoutMs = seconds(env.PI_GPU_SWAP_READY_TIMEOUT ?? file.readyTimeoutSeconds, config.readyTimeoutMs);
	config.leaseWaitMs = seconds(env.PI_GPU_SWAP_LEASE_WAIT ?? file.leaseWaitSeconds, config.leaseWaitMs);
	config.idleMs = seconds(env.PI_GPU_SWAP_IDLE_MINUTES !== undefined ? Number(env.PI_GPU_SWAP_IDLE_MINUTES) * 60 : file.idleMinutes !== undefined ? Number(file.idleMinutes) * 60 : undefined, config.idleMs);
	config.heartbeatMs = seconds(file.heartbeatSeconds, config.heartbeatMs);
	config.staleMs = seconds(file.staleSeconds, config.staleMs);
	config.pollMs = seconds(file.pollSeconds, config.pollMs);
	const leaseFile = env.PI_GPU_SWAP_LEASE_FILE ?? file.leaseFile;
	if (typeof leaseFile === "string" && leaseFile) config.leaseFile = expand(leaseFile);
	const systemctl = env.PI_GPU_SWAP_SYSTEMCTL ?? file.systemctl;
	if (typeof systemctl === "string" && systemctl) config.systemctl = expand(systemctl);
	return config;
}

/** The backend a provider needs, or undefined when gpu-swap leaves that provider alone. */
export function backendFor(config: GpuSwapConfig, provider: string | undefined): string | undefined {
	return provider ? config.providers[provider] : undefined;
}
