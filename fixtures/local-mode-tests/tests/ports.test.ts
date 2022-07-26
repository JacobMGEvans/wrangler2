import wrangler from "wrangler";

describe("worker", () => {
	type Worker = {
		fetch: (init?: RequestInit) => Promise<Response>;
		stop: () => Promise<void>;
	};
	let workers: Worker[];

	beforeAll(async () => {
		//since the script is invoked from the directory above, need to specify index.js is in src/

		workers = await Promise.all([
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
			wrangler.unstable_dev("src/basicModule.ts") as Worker,
		]);
	});

	afterAll(async () => {
		await Promise.all(workers.map(async (worker) => await worker.stop()));
	});

	it("should invoke the worker and exit", async () => {
		const responses = await Promise.all(
			workers.map(async (worker) => await worker.fetch())
		);
		const texts = await Promise.all(
			responses.map(async (resp) => await resp.text())
		);
		console.log("texts: ", texts);
		// expect(resp).not.toBe(undefined);

		// expect(text).toMatchInlineSnapshot(`"Hello World!"`);
	});
});
