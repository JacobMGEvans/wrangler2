import assert from "node:assert";
import { fork } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { watch } from "chokidar";
import onExit from "signal-exit";
import tmp from "tmp-promise";
import { bundleWorker } from "../bundle";
import { runCustomBuild } from "../entry";
import { logger } from "../logger";
import { DEFAULT_MODULE_RULES } from "../module-collection";
import { waitForPortToBeAvailable } from "../proxy";

import type { Config } from "../config";
import type { Entry } from "../entry";
import type { DevProps, DirectorySyncResult } from "./dev";
import type { LocalProps } from "./local";
import type { EsbuildBundle } from "./use-esbuild";

import type { WatchMode } from "esbuild";
import type { MiniflareOptions } from "miniflare";
import type { ChildProcess } from "node:child_process";

export async function implementation(
	props: DevProps & {
		local: boolean;
	}
) {
	if (
		!props.isWorkersSite &&
		props.assetPaths &&
		props.entry.format === "service-worker"
	) {
		throw new Error(
			"You cannot use the service-worker format with an `assets` directory yet. For information on how to migrate to the module-worker format, see: https://developers.cloudflare.com/workers/learning/migrating-to-module-workers/"
		);
	}

	if (props.bindings.wasm_modules && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code"
		);
	}

	if (props.bindings.text_blobs && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [text_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}

	if (props.bindings.data_blobs && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [data_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}
	// implement a react-free version of useCustomBuild
	const watcher = setupCustomBuild(props.entry, props.build);

	//implement a react-free version of useTmpDir
	const directory = setupTempDir();
	if (!directory) {
		throw new Error("Failed to create temporary directory.");
	}
	//implement a react-free version of useEsbuild
	const bundle = await runEsbuild({
		entry: props.entry,
		destination: directory.name,
		jsxFactory: props.jsxFactory,
		rules: props.rules,
		jsxFragment: props.jsxFragment,
		serveAssetsFromWorker: Boolean(
			props.assetPaths && !props.isWorkersSite && props.local
		),
		tsconfig: props.tsconfig,
		minify: props.minify,
		nodeCompat: props.nodeCompat,
		define: props.define,
		noBundle: props.noBundle,
	});

	//run local now
	await setupLocalServer({
		name: props.name,
		bundle: bundle,
		format: props.entry.format,
		compatibilityDate: props.compatibilityDate,
		compatibilityFlags: props.compatibilityFlags,
		bindings: props.bindings,
		assetPaths: props.assetPaths,
		isWorkersSite: props.isWorkersSite,
		port: props.port,
		ip: props.ip,
		rules: props.rules,
		inspectorPort: props.inspectorPort,
		enableLocalPersistence: props.enableLocalPersistence,
		liveReload: props.liveReload,
		crons: props.crons,
		localProtocol: props.localProtocol,
		localUpstream: props.localUpstream,
		logLevel: props.logLevel,
		logPrefix: props.logPrefix,
		inspect: props.inspect,
		onReady: props.onReady,
		enablePagesAssetsServiceBinding: props.enablePagesAssetsServiceBinding,
	});
}

function setupCustomBuild(
	expectedEntry: Entry,
	build: Config["build"]
): ReturnType<typeof watch> | undefined {
	if (!build.command) return;
	let watcher: ReturnType<typeof watch> | undefined;
	if (build.watch_dir) {
		watcher = watch(build.watch_dir, {
			persistent: true,
			ignoreInitial: true,
		}).on("all", (_event, filePath) => {
			const relativeFile =
				path.relative(expectedEntry.directory, expectedEntry.file) || ".";
			//TODO: we should buffer requests to the proxy until this completes
			logger.log(`The file ${filePath} changed, restarting build...`);
			runCustomBuild(expectedEntry.file, relativeFile, build).catch((err) => {
				logger.error("Custom build failed:", err);
			});
		});
		return watcher;
	}
}

function setupTempDir(): DirectorySyncResult | undefined {
	let dir: DirectorySyncResult | undefined;
	try {
		dir = tmp.dirSync({ unsafeCleanup: true });

		return dir;
	} catch (err) {
		logger.error("Failed to create temporary directory to store built files.");
	}
}

async function runEsbuild({
	entry,
	destination,
	jsxFactory,
	jsxFragment,
	rules,
	serveAssetsFromWorker,
	tsconfig,
	minify,
	nodeCompat,
	define,
	noBundle,
}: {
	entry: Entry;
	destination: string | undefined;
	jsxFactory: string | undefined;
	jsxFragment: string | undefined;
	rules: Config["rules"];
	define: Config["define"];
	serveAssetsFromWorker: boolean;
	tsconfig: string | undefined;
	minify: boolean | undefined;
	nodeCompat: boolean | undefined;
	noBundle: boolean;
}): Promise<EsbuildBundle | undefined> {
	let stopWatching: (() => void) | undefined = undefined;
	let bundle: EsbuildBundle | undefined;
	function setBundle(b: EsbuildBundle) {
		bundle = b;
	}

	function updateBundle() {
		// nothing really changes here, so let's increment the id
		// to change the return object's identity
		const previousBundle = bundle;
		assert(
			previousBundle,
			"Rebuild triggered with no previous build available"
		);
		setBundle({ ...previousBundle, id: previousBundle.id + 1 });
	}

	const watchMode: WatchMode = {
		async onRebuild(error) {
			if (error) logger.error("Watch build failed:", error);
			else {
				updateBundle();
			}
		},
	};

	async function build() {
		if (!destination) return;

		const {
			resolvedEntryPointPath,
			bundleType,
			modules,
			stop,
		}: Awaited<ReturnType<typeof bundleWorker>> = noBundle
			? {
					modules: [],
					resolvedEntryPointPath: entry.file,
					bundleType: entry.format === "modules" ? "esm" : "commonjs",
					stop: undefined,
			  }
			: await bundleWorker(entry, destination, {
					serveAssetsFromWorker,
					jsxFactory,
					jsxFragment,
					rules,
					watch: watchMode,
					tsconfig,
					minify,
					nodeCompat,
					define,
					checkFetch: true,
			  });

		// Capture the `stop()` method to use as the `useEffect()` destructor.
		stopWatching = stop;

		// if "noBundle" is true, then we need to manually watch the entry point and
		// trigger "builds" when it changes
		if (noBundle) {
			const watcher = watch(entry.file, {
				persistent: true,
			}).on("change", async (_event) => {
				updateBundle();
			});

			stopWatching = () => {
				watcher.close();
			};
		}

		setBundle({
			id: 0,
			entry,
			path: resolvedEntryPointPath,
			type: bundleType,
			modules,
		});
	}

	await build().catch((err) => {
		// If esbuild fails on first run, we want to quit the process
		// since we can't recover from here
		// related: https://github.com/evanw/esbuild/issues/1037
		stopWatching?.();
		throw new Error(err);
	});
	return bundle;
}

export async function setupLocalServer({
	name: workerName,
	bundle,
	format,
	compatibilityDate,
	compatibilityFlags,
	bindings,
	assetPaths,
	isWorkersSite,
	port,
	inspectorPort,
	rules,
	enableLocalPersistence,
	liveReload,
	ip,
	crons,
	localProtocol,
	localUpstream,
	inspect,
	onReady,
	logLevel,
	logPrefix,
	enablePagesAssetsServiceBinding,
}: LocalProps) {
	let local: ChildProcess | undefined;
	let removeSignalExitListener: (() => void) | undefined;
	let inspectorUrl: string | undefined;
	const setInspectorUrl = (url: string) => {
		inspectorUrl = url;
	};

	// if we're using local persistence for data, we should use the cwd
	// as an explicit path, or else it'll use the temp dir
	// which disappears when dev ends
	const localPersistencePath = enableLocalPersistence
		? // Maybe we could make the path configurable as well?
		  path.join(process.cwd(), "wrangler-local-state")
		: // We otherwise choose null, but choose true later
		  // so that it's persisted in the temp dir across a dev session
		  // even when we change source and reload
		  null;

	const abortController = new AbortController();
	async function startLocalWorker() {
		if (!bundle || !format) return;

		// port for the worker
		await waitForPortToBeAvailable(port, {
			retryPeriod: 200,
			timeout: 2000,
			abortSignal: abortController.signal,
		});

		if (bindings.services && bindings.services.length > 0) {
			throw new Error(
				"⎔ Service bindings are not yet supported in local mode."
			);
		}

		// In local mode, we want to copy all referenced modules into
		// the output bundle directory before starting up
		for (const module of bundle.modules) {
			await writeFile(
				path.join(path.dirname(bundle.path), module.name),
				module.content
			);
		}

		const scriptPath = realpathSync(bundle.path);

		// the wasm_modules/text_blobs/data_blobs bindings are
		// relative to process.cwd(), but the actual worker bundle
		// is in the temp output directory; so we rewrite the paths to be absolute,
		// letting miniflare resolve them correctly

		// wasm
		const wasmBindings: Record<string, string> = {};
		for (const [name, filePath] of Object.entries(
			bindings.wasm_modules || {}
		)) {
			wasmBindings[name] = path.join(process.cwd(), filePath);
		}

		// text
		const textBlobBindings: Record<string, string> = {};
		for (const [name, filePath] of Object.entries(bindings.text_blobs || {})) {
			textBlobBindings[name] = path.join(process.cwd(), filePath);
		}

		// data
		const dataBlobBindings: Record<string, string> = {};
		for (const [name, filePath] of Object.entries(bindings.data_blobs || {})) {
			dataBlobBindings[name] = path.join(process.cwd(), filePath);
		}

		if (format === "service-worker") {
			for (const { type, name } of bundle.modules) {
				if (type === "compiled-wasm") {
					// In service-worker format, .wasm modules are referenced by global identifiers,
					// so we convert it here.
					// This identifier has to be a valid JS identifier, so we replace all non alphanumeric
					// characters with an underscore.
					const identifier = name.replace(/[^a-zA-Z0-9_$]/g, "_");
					wasmBindings[identifier] = name;
				} else if (type === "text") {
					// In service-worker format, text modules are referenced by global identifiers,
					// so we convert it here.
					// This identifier has to be a valid JS identifier, so we replace all non alphanumeric
					// characters with an underscore.
					const identifier = name.replace(/[^a-zA-Z0-9_$]/g, "_");
					textBlobBindings[identifier] = name;
				} else if (type === "buffer") {
					// In service-worker format, data blobs are referenced by global identifiers,
					// so we convert it here.
					// This identifier has to be a valid JS identifier, so we replace all non alphanumeric
					// characters with an underscore.
					const identifier = name.replace(/[^a-zA-Z0-9_$]/g, "_");
					dataBlobBindings[identifier] = name;
				}
			}
		}

		const upstream =
			typeof localUpstream === "string"
				? `${localProtocol}://${localUpstream}`
				: undefined;

		const options: MiniflareOptions = {
			name: workerName,
			port,
			scriptPath,
			https: localProtocol === "https",
			host: ip,
			modules: format === "modules",
			modulesRules: (rules || [])
				.concat(DEFAULT_MODULE_RULES)
				.map(({ type, globs: include, fallthrough }) => ({
					type,
					include,
					fallthrough,
				})),
			compatibilityDate,
			compatibilityFlags,
			kvNamespaces: bindings.kv_namespaces?.map((kv) => kv.binding),
			r2Buckets: bindings.r2_buckets?.map((r2) => r2.binding),
			durableObjects: Object.fromEntries(
				(bindings.durable_objects?.bindings ?? []).map<[string, string]>(
					(value) => [value.name, value.class_name]
				)
			),
			...(localPersistencePath
				? {
						cachePersist: path.join(localPersistencePath, "cache"),
						durableObjectsPersist: path.join(localPersistencePath, "do"),
						kvPersist: path.join(localPersistencePath, "kv"),
						r2Persist: path.join(localPersistencePath, "r2"),
				  }
				: {
						// We mark these as true, so that they'll
						// persist in the temp directory.
						// This means they'll persist across a dev session,
						// even if we change source and reload,
						// and be deleted when the dev session ends
						cachePersist: true,
						durableObjectsPersist: true,
						kvPersist: true,
						r2Persist: true,
				  }),

			liveReload,
			sitePath: assetPaths?.assetDirectory
				? path.join(assetPaths.baseDirectory, assetPaths.assetDirectory)
				: undefined,
			siteInclude: assetPaths?.includePatterns.length
				? assetPaths?.includePatterns
				: undefined,
			siteExclude: assetPaths?.excludePatterns.length
				? assetPaths.excludePatterns
				: undefined,
			bindings: bindings.vars,
			wasmBindings,
			textBlobBindings,
			dataBlobBindings,
			sourceMap: true,
			logUnhandledRejections: true,
			crons,
			upstream,
			disableLogs: logLevel === "none",
			logOptions: logPrefix ? { prefix: logPrefix } : undefined,
		};

		// The path to the Miniflare CLI assumes that this file is being run from
		// `wrangler-dist` and that the CLI is found in `miniflare-dist`.
		// If either of those paths change this line needs updating.
		const miniflareCLIPath = path.resolve(
			__dirname,
			"../miniflare-dist/index.mjs"
		);
		const miniflareOptions = JSON.stringify(options, null);

		logger.log("⎔ Starting a local server...");
		const nodeOptions = [
			"--experimental-vm-modules", // ensures that Miniflare can run ESM Workers
			"--no-warnings", // hide annoying Node warnings
			// "--log=VERBOSE", // uncomment this to Miniflare to log "everything"!
		];
		if (inspect) {
			nodeOptions.push("--inspect=" + `${ip}:${inspectorPort}`); // start Miniflare listening for a debugger to attach
		}

		const forkOptions = [miniflareOptions];

		if (enablePagesAssetsServiceBinding) {
			forkOptions.push(JSON.stringify(enablePagesAssetsServiceBinding));
		}

		const child = (local = fork(miniflareCLIPath, forkOptions, {
			cwd: path.dirname(scriptPath),
			execArgv: nodeOptions,
			stdio: "pipe",
		}));

		child.on("message", (message) => {
			if (message === "ready") {
				onReady?.();
			}
		});

		child.on("close", (code) => {
			if (code) {
				logger.log(`Miniflare process exited with code ${code}`);
			}
		});

		child.stdout?.on("data", (data: Buffer) => {
			process.stdout.write(data);
		});

		// parse the node inspector url (which may be received in chunks) from stderr
		let stderrData = "";
		let inspectorUrlFound = false;
		child.stderr?.on("data", (data: Buffer) => {
			if (!inspectorUrlFound) {
				stderrData += data.toString();
				const matches =
					/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9-]+)[\r|\n]/.exec(
						stderrData
					);
				if (matches) {
					inspectorUrlFound = true;
					setInspectorUrl(matches[1]);
				}
			}

			process.stderr.write(data);
		});

		child.on("exit", (code) => {
			if (code) {
				logger.error(`Miniflare process exited with code ${code}`);
			}
		});

		child.on("error", (error: Error) => {
			logger.error(`Miniflare process failed to spawn`);
			logger.error(error);
		});

		removeSignalExitListener = onExit((_code, _signal) => {
			logger.log("⎔ Shutting down local server.");
			child.kill();
			local = undefined;
		});
	}

	startLocalWorker().catch((err) => {
		logger.error("local worker:", err);
	});

	// return () => {
	// 	abortController.abort();
	// 	if (local.current) {
	// 		logger.log("⎔ Shutting down local server.");
	// 		local.current?.kill();
	// 		local.current = undefined;
	// 		removeSignalExitListener.current && removeSignalExitListener.current();
	// 		removeSignalExitListener.current = undefined;
	// 	}
	// };
}
