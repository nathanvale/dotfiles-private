// Bun bundles a text import into the runtime, so the lane instructions ship inside runtime/source-intake-classify.js.
declare module "*.md" {
	const text: string
	export default text
}
