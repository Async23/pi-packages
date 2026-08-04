import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
	send({ jsonrpc: "2.0", id, result: value });
}

input.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!("id" in message)) return;

	switch (message.method) {
		case "server/discover":
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
			break;
		case "initialize":
			result(message.id, {
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {}, resources: {}, prompts: {} },
				serverInfo: { name: "pi-mcp-control-test", version: "1.0.0" },
			});
			break;
		case "tools/list":
			result(message.id, {
				tools: [
					{
						name: "echo",
						description: "Echo text from the isolated integration server",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			});
			break;
		case "tools/call":
			result(message.id, {
				content: [{ type: "text", text: `echo:${message.params.arguments?.text ?? ""}` }],
			});
			break;
		case "resources/list":
			result(message.id, { resources: [] });
			break;
		case "resources/templates/list":
			result(message.id, { resourceTemplates: [] });
			break;
		case "prompts/list":
			result(message.id, { prompts: [] });
			break;
		case "ping":
			result(message.id, {});
			break;
		default:
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
	}
});
