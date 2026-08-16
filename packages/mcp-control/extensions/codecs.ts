import {
	applyEdits,
	getNodeValue,
	modify,
	parse,
	parseTree,
	printParseErrorCode,
	type FormattingOptions,
	type Node as JsonNode,
	type ParseError,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isRecord, redactConfig } from "./model.ts";

export class ConfigParseError extends Error {
	readonly format: "jsonc" | "toml";

	constructor(format: "jsonc" | "toml", message: string) {
		super(message);
		this.name = "ConfigParseError";
		this.format = format;
	}
}

export interface ParsedConfigDocument {
	root: Record<string, unknown>;
	serverMap: Record<string, unknown>;
	sourceTextByServer: Record<string, string>;
}

export interface ConfigCodec {
	parseDocument(content: string, rootPath: readonly string[]): ParsedConfigDocument;
	upsertServer(
		content: string,
		rootPath: readonly string[],
		serverName: string,
		config: Record<string, unknown>,
	): string;
	deleteServer(content: string, rootPath: readonly string[], serverName: string): string;
}

function getPath(root: unknown, path: readonly string[]): unknown {
	let current = root;
	for (const segment of path) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function jsoncErrors(errors: ParseError[]): string {
	return errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ");
}

function parseJsoncRoot(content: string): Record<string, unknown> {
	if (content.trim() === "") return {};
	const errors: ParseError[] = [];
	const parsed: unknown = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0) throw new ConfigParseError("jsonc", `Invalid JSON/JSONC: ${jsoncErrors(errors)}`);
	if (!isRecord(parsed)) throw new ConfigParseError("jsonc", "MCP configuration root must be an object");
	return parsed;
}

function detectFormatting(content: string): FormattingOptions {
	const firstIndented = content.match(/\n([ \t]+)\S/);
	const indentation = firstIndented?.[1] ?? "  ";
	return {
		insertSpaces: !indentation.includes("\t"),
		tabSize: indentation.includes("\t") ? 1 : Math.max(1, indentation.length),
		eol: content.includes("\r\n") ? "\r\n" : "\n",
	};
}

function ensureTrailingNewline(content: string, eol: string): string {
	return content.endsWith("\n") ? content : `${content}${eol}`;
}

function jsoncNodeAtPath(root: JsonNode, path: readonly string[]): JsonNode | undefined {
	let node: JsonNode | undefined = root;
	for (const segment of path) {
		if (node.type !== "object") return undefined;
		const property = node.children?.find((child) => child.children?.[0]?.value === segment);
		node = property?.children?.[1];
		if (!node) return undefined;
	}
	return node;
}

function jsoncSourceTextByServer(content: string, rootPath: readonly string[]): Record<string, string> {
	const errors: ParseError[] = [];
	const tree = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0 || !tree) return {};
	const container = jsoncNodeAtPath(tree, rootPath);
	if (container?.type !== "object") return {};

	const result: Record<string, string> = {};
	for (const property of container.children ?? []) {
		const key = property.children?.[0]?.value;
		const value = property.children?.[1];
		if (typeof key !== "string" || !value) continue;
		result[key] = content.slice(value.offset, value.offset + value.length);
	}
	return result;
}

export const jsoncCodec: ConfigCodec = {
	parseDocument(content, rootPath) {
		const root = parseJsoncRoot(content);
		const value = getPath(root, rootPath);
		const sourceTextByServer = jsoncSourceTextByServer(content, rootPath);
		if (value === undefined) return { root, serverMap: {}, sourceTextByServer };
		if (!isRecord(value)) {
			throw new ConfigParseError("jsonc", `MCP server container /${rootPath.join("/")} must be an object`);
		}
		return { root, serverMap: value, sourceTextByServer };
	},

	upsertServer(content, rootPath, serverName, config) {
		const original = content.trim() === "" ? "{}\n" : content;
		parseJsoncRoot(original);
		const formatting = detectFormatting(original);
		const edits = modify(original, [...rootPath, serverName], config, { formattingOptions: formatting });
		const next = applyEdits(original, edits);
		parseJsoncRoot(next);
		return ensureTrailingNewline(next, formatting.eol ?? "\n");
	},

	deleteServer(content, rootPath, serverName) {
		if (content.trim() === "") throw new ConfigParseError("jsonc", "Cannot delete from an empty configuration");
		parseJsoncRoot(content);
		const formatting = detectFormatting(content);
		const edits = modify(content, [...rootPath, serverName], undefined, { formattingOptions: formatting });
		const next = applyEdits(content, edits);
		parseJsoncRoot(next);
		return ensureTrailingNewline(next, formatting.eol ?? "\n");
	},
};

function parseTomlRoot(content: string): Record<string, unknown> {
	if (content.trim() === "") return {};
	try {
		const parsed: unknown = parseToml(content);
		if (!isRecord(parsed)) throw new ConfigParseError("toml", "TOML root must be a table");
		return parsed;
	} catch (error) {
		if (error instanceof ConfigParseError) throw error;
		throw new ConfigParseError("toml", `Invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseDoubleQuotedKey(input: string, start: number): { value: string; next: number } | undefined {
	let escaped = false;
	for (let index = start + 1; index < input.length; index += 1) {
		const character = input[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character !== '"') continue;
		try {
			return { value: JSON.parse(input.slice(start, index + 1)), next: index + 1 };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function parseSingleQuotedKey(input: string, start: number): { value: string; next: number } | undefined {
	const end = input.indexOf("'", start + 1);
	if (end < 0) return undefined;
	return { value: input.slice(start + 1, end), next: end + 1 };
}

export function parseTomlDottedKey(input: string): string[] | undefined {
	const segments: string[] = [];
	let index = 0;
	while (index < input.length) {
		while (/\s/.test(input[index] ?? "")) index += 1;
		if (index >= input.length) return segments.length > 0 ? segments : undefined;

		let parsed: { value: string; next: number } | undefined;
		if (input[index] === '"') parsed = parseDoubleQuotedKey(input, index);
		else if (input[index] === "'") parsed = parseSingleQuotedKey(input, index);
		else {
			const match = input.slice(index).match(/^[A-Za-z0-9_-]+/);
			if (match) parsed = { value: match[0], next: index + match[0].length };
		}
		if (!parsed) return undefined;
		segments.push(parsed.value);
		index = parsed.next;
		while (/\s/.test(input[index] ?? "")) index += 1;
		if (index >= input.length) return segments;
		if (input[index] !== ".") return undefined;
		index += 1;
	}
	return segments;
}

interface TomlSection {
	start: number;
	end: number;
	path: string[];
}

function tomlSections(content: string): TomlSection[] {
	const headers: Array<{ start: number; path: string[] }> = [];
	const pattern = /^[ \t]*\[([^\[\]]+)\][ \t]*(?:#.*)?$/gm;
	for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
		const path = parseTomlDottedKey(match[1] ?? "");
		if (path) headers.push({ start: match.index, path });
	}
	return headers.map((header, index) => ({
		...header,
		end: headers[index + 1]?.start ?? content.length,
	}));
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.every((segment, index) => path[index] === segment);
}

function leadingHeaderTriviaStart(content: string, headerStart: number, lowerBound: number): number {
	let start = headerStart;
	let cursor = headerStart;
	while (cursor > lowerBound) {
		const previousNewline = content.lastIndexOf("\n", Math.max(lowerBound, cursor - 2));
		const lineStart = Math.max(lowerBound, previousNewline + 1);
		const line = content.slice(lineStart, cursor).trim();
		if (line !== "" && !line.startsWith("#")) break;
		start = lineStart;
		if (lineStart === lowerBound) break;
		cursor = lineStart;
	}
	return start;
}

function matchingTomlSections(content: string, target: readonly string[]): TomlSection[] {
	const sections = tomlSections(content);
	return sections
		.map((section, index) => {
			if (!pathStartsWith(section.path, target)) return undefined;
			const next = sections[index + 1];
			return next && !pathStartsWith(next.path, target)
				? { ...section, end: leadingHeaderTriviaStart(content, next.start, section.start) }
				: section;
		})
		.filter((section): section is TomlSection => Boolean(section));
}

function tomlSourceTextByServer(
	content: string,
	rootPath: readonly string[],
	serverMap: Record<string, unknown>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const serverName of Object.keys(serverMap)) {
		const sections = matchingTomlSections(content, [...rootPath, serverName]);
		if (sections.length === 0) continue;
		result[serverName] = sections.map((section) => content.slice(section.start, section.end)).join("");
	}
	return result;
}

function renderTomlServer(serverName: string, config: Record<string, unknown>, eol: string): string {
	const rendered = stringifyToml({ mcp_servers: { [serverName]: config } }).trimEnd();
	return rendered.replace(/\n/g, eol);
}

function replaceTomlServer(content: string, serverName: string, config?: Record<string, unknown>): string {
	parseTomlRoot(content);
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const target = ["mcp_servers", serverName];
	const matching = matchingTomlSections(content, target);
	const insertionOffset = matching[0]?.start ?? content.length;
	let next = content;
	for (const section of [...matching].sort((left, right) => right.start - left.start)) {
		next = `${next.slice(0, section.start)}${next.slice(section.end)}`;
	}

	if (config) {
		const rendered = renderTomlServer(serverName, config, eol);
		let prefix = next.slice(0, insertionOffset);
		const suffix = next.slice(insertionOffset);
		if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += eol;
		if (prefix.trim().length > 0 && !prefix.endsWith(`${eol}${eol}`)) prefix += eol;
		next = `${prefix}${rendered}${eol}${suffix}`;
	}

	next = next.replace(new RegExp(`(?:${eol.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}){3,}`, "g"), `${eol}${eol}`);
	if (next.trim() !== "" && !next.endsWith("\n")) next += eol;
	parseTomlRoot(next);
	return next;
}

export const tomlCodec: ConfigCodec = {
	parseDocument(content, rootPath) {
		const root = parseTomlRoot(content);
		const value = getPath(root, rootPath);
		if (value === undefined) return { root, serverMap: {}, sourceTextByServer: {} };
		if (!isRecord(value)) {
			throw new ConfigParseError("toml", `MCP server table ${rootPath.join(".")} must be a table`);
		}
		return {
			root,
			serverMap: value,
			sourceTextByServer: tomlSourceTextByServer(content, rootPath, value),
		};
	},

	upsertServer(content, rootPath, serverName, config) {
		if (rootPath.length !== 1 || rootPath[0] !== "mcp_servers") {
			throw new ConfigParseError("toml", "Only Codex mcp_servers TOML tables are writable");
		}
		return replaceTomlServer(content, serverName, config);
	},

	deleteServer(content, rootPath, serverName) {
		if (rootPath.length !== 1 || rootPath[0] !== "mcp_servers") {
			throw new ConfigParseError("toml", "Only Codex mcp_servers TOML tables are writable");
		}
		return replaceTomlServer(content, serverName);
	},
};

export function codecFor(format: "jsonc" | "toml"): ConfigCodec {
	return format === "toml" ? tomlCodec : jsoncCodec;
}

export function serverDiff(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): string {
	const beforeText = before ? JSON.stringify(redactConfig(before), null, 2) : "<missing>";
	const afterText = after ? JSON.stringify(redactConfig(after), null, 2) : "<deleted>";
	const beforeLines = beforeText.split("\n");
	const afterLines = afterText.split("\n");
	return [
		"--- before",
		"+++ after",
		...beforeLines.map((line) => `- ${line}`),
		...afterLines.map((line) => `+ ${line}`),
	].join("\n");
}

export function readJsoncNode(content: string, path: readonly string[]): unknown {
	const errors: ParseError[] = [];
	const tree = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0 || !tree) return undefined;
	const node = jsoncNodeAtPath(tree, path);
	return node ? getNodeValue(node) : undefined;
}
