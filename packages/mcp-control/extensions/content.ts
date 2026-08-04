import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/client";
import { isRecord } from "./model.ts";

export interface PiTextContent {
	type: "text";
	text: string;
}

export interface PiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type PiContent = PiTextContent | PiImageContent;

const MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024;
const MAX_STRUCTURED_TEXT_CHARS = 48 * 1024;
const MAX_TEXT_CHARS = 256 * 1024;

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n… <truncated ${value.length - limit} characters>`;
}

function stringifyStructured(value: unknown): string {
	try {
		return truncate(JSON.stringify(value, null, 2), MAX_STRUCTURED_TEXT_CHARS);
	} catch {
		return "<unserializable structured MCP content>";
	}
}

function resourceContentsToContent(resource: unknown): PiContent[] {
	if (!isRecord(resource)) return [{ type: "text", text: "[MCP embedded resource: invalid content]" }];
	const uri = typeof resource.uri === "string" ? resource.uri : "unknown URI";
	if (typeof resource.text === "string") {
		return [{ type: "text", text: `[MCP resource ${uri}]\n${truncate(resource.text, MAX_TEXT_CHARS)}` }];
	}
	if (typeof resource.blob === "string") {
		const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
		return [{ type: "text", text: `[MCP binary resource ${uri}; ${mime}; ${resource.blob.length} base64 characters]` }];
	}
	return [{ type: "text", text: `[MCP embedded resource ${uri}: no readable content]` }];
}

export function adaptMcpContentBlock(block: unknown): PiContent[] {
	if (!isRecord(block) || typeof block.type !== "string") {
		return [{ type: "text", text: `[Unknown MCP content]\n${stringifyStructured(block)}` }];
	}
	if (block.type === "text" && typeof block.text === "string") {
		return [{ type: "text", text: truncate(block.text, MAX_TEXT_CHARS) }];
	}
	if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
		if (block.data.length > MAX_IMAGE_BASE64_CHARS) {
			return [{ type: "text", text: `[MCP image omitted: ${block.mimeType}; payload exceeds 10 MiB]` }];
		}
		return [{ type: "image", data: block.data, mimeType: block.mimeType }];
	}
	if (block.type === "audio") {
		const mime = typeof block.mimeType === "string" ? block.mimeType : "audio/unknown";
		const size = typeof block.data === "string" ? block.data.length : 0;
		return [{ type: "text", text: `[MCP audio attachment: ${mime}; ${size} base64 characters; Pi tool results do not support audio]` }];
	}
	if (block.type === "resource_link") {
		const name = typeof block.name === "string" ? block.name : "resource";
		const uri = typeof block.uri === "string" ? block.uri : "unknown URI";
		const mime = typeof block.mimeType === "string" ? `; ${block.mimeType}` : "";
		return [{ type: "text", text: `[MCP resource link: ${name}; ${uri}${mime}]` }];
	}
	if (block.type === "resource") return resourceContentsToContent(block.resource);
	return [{ type: "text", text: `[Unsupported MCP ${block.type} content]\n${stringifyStructured(block)}` }];
}

export function adaptToolResult(result: CallToolResult): {
	content: PiContent[];
	details: Record<string, unknown>;
} {
	const content = result.content.flatMap(adaptMcpContentBlock);
	if (result.structuredContent !== undefined) {
		content.push({ type: "text", text: `[MCP structured content]\n${stringifyStructured(result.structuredContent)}` });
	}
	if (result.isError) {
		content.unshift({ type: "text", text: "MCP tool reported an execution error. The following content is the server's error result:" });
	}
	if (content.length === 0) content.push({ type: "text", text: "MCP tool completed without content." });
	return {
		content,
		details: {
			mcpIsError: result.isError === true,
			structuredContent: result.structuredContent,
			_meta: result._meta,
		},
	};
}

export function adaptResourceResult(result: ReadResourceResult): {
	content: PiContent[];
	details: Record<string, unknown>;
} {
	const content = result.contents.flatMap((resource) => resourceContentsToContent(resource));
	if (content.length === 0) content.push({ type: "text", text: "MCP resource returned no content." });
	return { content, details: { resourceCount: result.contents.length, _meta: result._meta } };
}

export function formatPromptResult(result: GetPromptResult): string {
	const lines: string[] = [];
	if (result.description) lines.push(result.description, "");
	for (const message of result.messages) {
		lines.push(`--- ${message.role} ---`);
		for (const content of adaptMcpContentBlock(message.content)) {
			if (content.type === "text") lines.push(content.text);
			else lines.push(`[image: ${content.mimeType}; ${content.data.length} base64 characters]`);
		}
	}
	return lines.join("\n").trim();
}
