import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256 } from "./model.ts";

export interface ConfigFileRecord {
	path: string;
	exists: boolean;
	content: string;
	hash: string | null;
	mode?: number;
}

export interface AtomicWriteRequest {
	path: string;
	content: string;
	expectedHash: string | null;
	backupLabel?: string;
}

export interface AtomicWriteResult {
	path: string;
	created: boolean;
	backupPath?: string;
	hash: string;
}

export class ConcurrentConfigChangeError extends Error {
	readonly path: string;

	constructor(path: string) {
		super(`Configuration changed since preview: ${path}`);
		this.name = "ConcurrentConfigChangeError";
		this.path = path;
	}
}

export class UnsafeConfigPathError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`Refusing to write ${path}: ${reason}`);
		this.name = "UnsafeConfigPathError";
		this.path = path;
	}
}

export interface ConfigFileStore {
	read(path: string): ConfigFileRecord;
	writeAtomic(request: AtomicWriteRequest): AtomicWriteResult;
}

function timestampForFile(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function assertSafeTarget(path: string): void {
	if (!existsSync(path)) return;
	const stats = lstatSync(path);
	if (stats.isSymbolicLink()) throw new UnsafeConfigPathError(path, "target is a symbolic link");
	if (!stats.isFile()) throw new UnsafeConfigPathError(path, "target is not a regular file");
}

function fsyncDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export class NodeConfigFileStore implements ConfigFileStore {
	read(path: string): ConfigFileRecord {
		if (!existsSync(path)) return { path, exists: false, content: "", hash: null };
		assertSafeTarget(path);
		const content = readFileSync(path, "utf8");
		return {
			path,
			exists: true,
			content,
			hash: sha256(content),
			mode: statSync(path).mode & 0o777,
		};
	}

	writeAtomic(request: AtomicWriteRequest): AtomicWriteResult {
		const before = this.read(request.path);
		if (before.hash !== request.expectedHash) throw new ConcurrentConfigChangeError(request.path);

		const directory = dirname(request.path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		assertSafeTarget(request.path);

		let backupPath: string | undefined;
		if (before.exists) {
			const label = request.backupLabel ?? "pi-mcp-control";
			const base = `${request.path}.${label}.${timestampForFile()}.bak`;
			backupPath = base;
			for (let index = 1; existsSync(backupPath); index += 1) backupPath = `${base}.${index}`;
			try {
				linkSync(request.path, backupPath);
			} catch {
				copyFileSync(request.path, backupPath);
			}
		}

		const temporaryPath = join(
			directory,
			`.${basename(request.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
		);
		let fd: number | undefined;
		try {
			fd = openSync(temporaryPath, "wx", before.mode ?? 0o600);
			writeFileSync(fd, request.content, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(temporaryPath, request.path);
			fsyncDirectory(directory);
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			try {
				unlinkSync(temporaryPath);
			} catch {
				// Nothing to clean up.
			}
			throw error;
		}

		return {
			path: request.path,
			created: !before.exists,
			backupPath,
			hash: sha256(request.content),
		};
	}
}

interface MemoryFile {
	content: string;
	mode: number;
}

export class MemoryConfigFileStore implements ConfigFileStore {
	readonly #files = new Map<string, MemoryFile>();
	readonly backups = new Map<string, string>();

	constructor(initialFiles: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initialFiles)) this.#files.set(path, { content, mode: 0o600 });
	}

	read(path: string): ConfigFileRecord {
		const file = this.#files.get(path);
		if (!file) return { path, exists: false, content: "", hash: null };
		return { path, exists: true, content: file.content, hash: sha256(file.content), mode: file.mode };
	}

	writeAtomic(request: AtomicWriteRequest): AtomicWriteResult {
		const before = this.read(request.path);
		if (before.hash !== request.expectedHash) throw new ConcurrentConfigChangeError(request.path);
		let backupPath: string | undefined;
		if (before.exists) {
			backupPath = `${request.path}.pi-mcp-control.memory.bak.${this.backups.size + 1}`;
			this.backups.set(backupPath, before.content);
		}
		this.#files.set(request.path, { content: request.content, mode: before.mode ?? 0o600 });
		return {
			path: request.path,
			created: !before.exists,
			backupPath,
			hash: sha256(request.content),
		};
	}

	set(path: string, content: string): void {
		this.#files.set(path, { content, mode: 0o600 });
	}

	delete(path: string): void {
		this.#files.delete(path);
	}
}
