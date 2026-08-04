import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";
import type { InternalServerEntry, RuntimeServerDefinition } from "./model.ts";

export interface PolicyDecision {
	allowed: boolean;
	reason?: string;
}

/**
 * Replaceable seam for the deferred activation/reconnect decision.
 * The default policy requires an explicit panel action and only permits the
 * effective, enabled entry to connect.
 */
export interface McpActivationPolicy {
	shouldAutoConnect(entry: InternalServerEntry): boolean;
	canConnect(entry: InternalServerEntry): PolicyDecision;
}

export const explicitActivationPolicy: McpActivationPolicy = {
	shouldAutoConnect() {
		return false;
	},
	canConnect(entry) {
		if (entry.resolution === "active" || entry.resolution === "unknown-precedence") return { allowed: true };
		if (entry.resolution === "disabled") {
			return { allowed: false, reason: `${entry.agentLabel} / ${entry.serverName} is disabled in its source configuration.` };
		}
		return {
			allowed: false,
			reason: `${entry.agentLabel} / ${entry.serverName} is not the effective source entry (${entry.resolution}).`,
		};
	},
};

export type McpInvocationRequest =
	| {
			kind: "tool";
			definition: RuntimeServerDefinition;
			tool: Tool;
			arguments: Record<string, unknown>;
		}
	| {
			kind: "resource";
			definition: RuntimeServerDefinition;
			uri: string;
		};

/** Replaceable seam for the deferred per-call approval/security policy. */
export interface McpInvocationPolicy {
	authorize(request: McpInvocationRequest, ctx: ExtensionContext): Promise<PolicyDecision> | PolicyDecision;
}

/** Explicit connection is the approval boundary until a later policy is chosen. */
export const allowConnectedInvocationPolicy: McpInvocationPolicy = {
	authorize() {
		return { allowed: true };
	},
};
