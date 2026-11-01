import { MAX_PRIVATE_INPUT_BYTES } from "../../../bin/private-input.ts";
// Admitted subset of TypeSafe OpenAPI 0.2.0: choice and noul only.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Content = string | Json[] | { [key: string]: Json };
export type Question =
	| {
			type: "choice";
			criteria: Record<string, Content | null>;
			instructions?: Content | null;
	  }
	| {
			type: "noul";
			criteria?: { true?: Content | null; false?: Content | null } | null;
			instructions?: Content | null;
	  };
export interface InferenceInput {
	requestKey: string;
	model: string;
	state: Content;
	questions: Record<string, Question>;
}
export type Answer =
	| {
			type: "choice";
			choice: string;
			confidence: number;
			probabilities: Record<string, number>;
	  }
	| { type: "noul"; noul: number };
export interface InferenceResponse {
	model: string;
	answers: Record<string, Answer>;
	usage: { input_tokens: number; output_tokens: number };
	requestId: string | null;
}
export const TOOLS = ["list_models", "system_one"] as const;
const MAX_BODY_BYTES = MAX_PRIVATE_INPUT_BYTES;
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
function json(value: unknown, depth = 0): value is Json {
	if (depth > 64) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((entry) => json(entry, depth + 1));
	return record(value) && Object.values(value).every((entry) => json(entry, depth + 1));
}
const content = (value: unknown): value is Content | null => json(value) && (value === null || typeof value === "string" || typeof value === "object");
function question(value: unknown): value is Question {
	if (!record(value) || !keys(value, ["type", "criteria", "instructions"])) return false;
	if ("instructions" in value && !content(value.instructions)) return false;
    if ("criteria" in value && !json(value.criteria)) return false;
	if (value.type === "choice")
		return (
			record(value.criteria) &&
			Object.keys(value.criteria).length > 0 &&
			Object.keys(value.criteria).length <= 255 &&
			Object.values(value.criteria).every(content)
		);
	if (value.type !== "noul") return false;
	return (
		!("criteria" in value) ||
		value.criteria === null ||
		(record(value.criteria) && keys(value.criteria, ["true", "false"]) && Object.values(value.criteria).every(content))
	);
}
export function inferenceInput(value: unknown): value is InferenceInput {
	if (!record(value) || !keys(value, ["requestKey", "model", "state", "questions"])) return false;
	if (typeof value.requestKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestKey)) return false;
	if (typeof value.model !== "string" || !/^jev-[0-9]+\.[0-9]+\.[0-9]+$/.test(value.model)) return false;
	if (
		value.state === null ||
		!content(value.state) ||
		!record(value.questions) ||
		Object.keys(value.questions).length === 0 ||
		!Object.values(value.questions).every(question)
	)
		return false;
	return Buffer.byteLength(JSON.stringify(value)) <= MAX_BODY_BYTES;
}
export function operationInput(operation: string, input: unknown): boolean {
	return operation === "system_one" ? inferenceInput(input) : operation === "list_models" && record(input) && Object.keys(input).length === 0;
}
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
function answer(value: unknown, asked: Question): value is Answer {
	if (!record(value) || value.type !== asked.type) return false;
	if (value.type === "noul") return probability(value.noul);
	if (
		asked.type !== "choice" ||
		typeof value.choice !== "string" ||
		!Object.hasOwn(asked.criteria, value.choice) ||
		!probability(value.confidence) ||
		!record(value.probabilities)
	)
		return false;
	return (
		JSON.stringify(Object.keys(value.probabilities).sort()) === JSON.stringify(Object.keys(asked.criteria).sort()) &&
		Object.values(value.probabilities).every(probability)
	);
}
const tokens = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
export function inferenceResponse(value: unknown, input: InferenceInput, requestId: string | null): InferenceResponse | null {
	if (
		!record(value) ||
		value.model !== input.model ||
		!record(value.answers) ||
		!record(value.usage) ||
		!tokens(value.usage.input_tokens) ||
		!tokens(value.usage.output_tokens)
	)
		return null;
	if (JSON.stringify(Object.keys(value.answers).sort()) !== JSON.stringify(Object.keys(input.questions).sort())) return null;
	const answers: [string, Answer][] = [];
	for (const [name, asked] of Object.entries(input.questions)) {
		const valueAnswer = value.answers[name];
		if (!answer(valueAnswer, asked)) return null;
        const projected: Answer = valueAnswer.type === "noul" ? { type: "noul", noul: valueAnswer.noul } : { type: "choice", choice: valueAnswer.choice, confidence: valueAnswer.confidence, probabilities: Object.fromEntries(Object.entries(valueAnswer.probabilities)) };
		answers.push([name, projected]);
	}
	return {
		model: input.model,
		answers: Object.fromEntries(answers),
		usage: {
			input_tokens: value.usage.input_tokens,
			output_tokens: value.usage.output_tokens,
		},
		requestId,
	};
}
export interface Model {
	name: string;
	description: string;
	release_date: string;
}
export function modelsResponse(value: unknown): Model[] | null {
	if (!record(value) || !Array.isArray(value.models)) return null;
	const models: Model[] = [];
	for (const model of value.models) {
		if (!record(model) || typeof model.name !== "string" || typeof model.description !== "string" || typeof model.release_date !== "string") return null;
		models.push({
			name: model.name,
			description: model.description,
			release_date: model.release_date,
		});
	}
	return models;
}
const contentSchema = () => ({ anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }, { type: "null" }] });
export const TOOL_SCHEMAS = [
	{
		name: "list_models",
		description: "List available TypeSafe models and aliases",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {},
		},
	},
	{
		name: "system_one",
		description: "One paid choice/noul inference with a durable non-replayable request key; 256 KiB local bound",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["requestKey", "model", "state", "questions"],
			properties: {
				requestKey: {
					type: "string",
					pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
				},
				model: { type: "string", pattern: "^jev-[0-9]+\\.[0-9]+\\.[0-9]+$" },
				state: {
					anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
				},
				questions: {
					type: "object",
					minProperties: 1,
					additionalProperties: {
						oneOf: [
							{
								type: "object",
								additionalProperties: false,
								required: ["type", "criteria"],
								properties: {
									type: { const: "choice" },
									instructions: contentSchema(),
									criteria: {
										type: "object",
										minProperties: 1,
										maxProperties: 255,
										additionalProperties: contentSchema(),
									},
								},
							},
							{
								type: "object",
								additionalProperties: false,
								required: ["type"],
								properties: {
									type: { const: "noul" },
									instructions: contentSchema(),
									criteria: {
										type: ["object", "null"],
										properties: { true: contentSchema(), false: contentSchema() },
										additionalProperties: false,
									},
								},
							},
						],
					},
				},
			},
		},
	},
];

export const WIRE_TOOL_SCHEMAS = TOOL_SCHEMAS.map((tool) => tool.name === "system_one" ? { ...tool, inputSchema: { type: "object", additionalProperties: false, required: ["requestJson"], properties: { requestJson: { type: "string", maxLength: MAX_PRIVATE_INPUT_BYTES } } } } : tool);
