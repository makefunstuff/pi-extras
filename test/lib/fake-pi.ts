// A stand-in for pi's ExtensionAPI in unit tests: records what an extension registers and lets a
// test fire the events it subscribed to.
//
//   const pi = fakePi();
//   extension(pi as any);
//   pi.tools.get("my_tool")      registered tool definitions, by name
//   pi.commands.get("my-cmd")    registered commands, by name
//   pi.providers.get("name")     registered providers, by name (unregisterProvider deletes one)
//   await pi.emit("session_start", event, ctx)   calls every handler, returns their results
//
// Any other API method is accepted and recorded in `calls`, so extensions using parts of the API
// this fake does not model still load.
export interface FakePi {
	tools: Map<string, any>;
	commands: Map<string, any>;
	providers: Map<string, any>;
	flags: Map<string, any>;
	handlers: Map<string, Array<(...args: any[]) => any>>;
	calls: Array<{ method: string; args: any[] }>;
	emit(event: string, ...args: any[]): Promise<any[]>;
	[method: string]: any;
}

export function fakePi(): FakePi {
	const state = {
		tools: new Map<string, any>(),
		commands: new Map<string, any>(),
		providers: new Map<string, any>(),
		flags: new Map<string, any>(),
		handlers: new Map<string, Array<(...args: any[]) => any>>(),
		calls: [] as Array<{ method: string; args: any[] }>,
		async emit(event: string, ...args: any[]) {
			const out: any[] = [];
			for (const h of state.handlers.get(event) ?? []) out.push(await h(...args));
			return out;
		},
	};
	const known: Record<string, (...args: any[]) => any> = {
		registerTool: (def: any) => void state.tools.set(def.name, def),
		registerCommand: (name: string, def: any) => void state.commands.set(name, def),
		registerProvider: (name: string, def: any) => void state.providers.set(name, def),
		unregisterProvider: (name: string) => void state.providers.delete(name),
		registerFlag: (name: string, def: any) => void state.flags.set(name, def),
		getFlag: (name: string) => state.flags.get(name)?.default,
		on: (event: string, handler: (...args: any[]) => any) => {
			if (!state.handlers.has(event)) state.handlers.set(event, []);
			state.handlers.get(event)!.push(handler);
		},
	};
	return new Proxy(state as FakePi, {
		get(target, prop: string) {
			if (prop in target) return (target as any)[prop];
			if (prop === "then") return undefined; // not a thenable
			return (...args: any[]) => {
				target.calls.push({ method: prop, args });
				return known[prop]?.(...args);
			};
		},
	});
}

// A minimal ExtensionContext for handlers and tool execution.
export function fakeCtx(overrides: Record<string, any> = {}): any {
	const notes: Array<{ message: string; level?: string }> = [];
	return {
		cwd: process.cwd(),
		hasUI: false,
		notes,
		ui: {
			notify: (message: string, level?: string) => void notes.push({ message, level }),
			setStatus: () => {},
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
		},
		...overrides,
	};
}
