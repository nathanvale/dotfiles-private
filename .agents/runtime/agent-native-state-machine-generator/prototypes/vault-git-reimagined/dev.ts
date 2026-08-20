import prototype from "./index.html";

const port = Number(process.env.PROTOTYPE_PORT ?? 4177);

const server = Bun.serve({
	development: true,
	port,
	routes: {
		"/*": prototype,
	},
});

console.log(`Vault Git reimagined prototype: ${server.url}`);
