import { setTimeout, clearTimeout } from "node:timers";
import type { SessionHeader } from "./session-entries";
import type { DeferredResumeEntry } from "./session-entries";

export interface DeferredSessionInfo {
	sessionId: string;
	sessionFile: string;
}

/** Callback interface for the deferred run manager to interact with the session system. */
export interface DeferredRunCallbacks {
	/** List all sessions that might have deferred resumes. */
	listSessions(): Promise<DeferredSessionInfo[]>;
	/** Load the session header to read generation. */
	loadSessionHeader(sessionFile: string): Promise<SessionHeader | null>;
	/** Check if a session has a pending deferred resume entry. */
	findDeferredResume(sessionFile: string): Promise<DeferredResumeEntry | null>;
	/** Atomically consume the deferred resume entry (mark as resumed). Returns true if successful. */
	consumeDeferredResume(sessionFile: string): Promise<boolean>;
	/** Cancel (delete) a pending deferred resume entry. */
	cancelDeferredResume(sessionFile: string): Promise<void>;
	/** Trigger agent continuation for the session. */
	resumeSession(sessionId: string, generation: number, model: string): void;
}

interface PendingResume {
	info: DeferredResumeEntry & { sessionId: string; sessionFile: string };
	timer: Timer;
}

/**
 * Manages durable deferred run scheduling. When a provider usage-limit error
 * requests a wait longer than retry.maxDelayMs, the run is persisted as deferred
 * and resumed automatically when the wait expires.
 *
 * Uses a session generation counter as the invalidation mechanism: user
 * interaction increments the generation, so a stale timer that fires after
 * user action sees a mismatch and discards the resume.
 */
export class DeferredRunManager {
	#pendingResumes: Map<string, PendingResume> = new Map();
	#callbacks: DeferredRunCallbacks;

	constructor(callbacks: DeferredRunCallbacks) {
		this.#callbacks = callbacks;
	}

	/**
	 * Schedule a deferred resume for a session. The entry must already be
	 * persisted to the session file by the caller.
	 */
	scheduleResume(sessionId: string, sessionFile: string, entry: DeferredResumeEntry): void {
		// Cancel only the in-memory timer (caller already persisted the entry)
		this.#cancelTimer(sessionId);

		const info = { ...entry, sessionId, sessionFile };
		const delayMs = Math.max(0, entry.resume_at - Date.now());
		const timer = setTimeout(() => {
			this.#pendingResumes.delete(sessionId);
			this.#fireResume(info);
		}, delayMs);
		timer.unref();

		this.#pendingResumes.set(sessionId, { info, timer });
	}

	/**
	 * Initialize the manager by scanning for deferred resumes that should
	 * be active. Called on startup.
	 */
	async init(): Promise<void> {
		const sessions = await this.#callbacks.listSessions();

		for (const session of sessions) {
			const header = await this.#callbacks.loadSessionHeader(session.sessionFile);
			if (!header) continue;

			const entry = await this.#callbacks.findDeferredResume(session.sessionFile);
			if (!entry || entry.consumed) continue;

			const now = Date.now();

			if (entry.resume_at <= now) {
				// Resume time has passed — try to resume immediately
				await this.#tryResume(session, header, entry);
			} else {
				// Schedule for future
				this.scheduleResume(session.sessionId, session.sessionFile, entry);
			}
		}
	}

	/** Cancel a scheduled resume for a session (in-memory timer + persisted entry). */
	cancelResume(sessionId: string, sessionFile: string): void {
		this.#cancelTimer(sessionId);
		this.#callbacks.cancelDeferredResume(sessionFile).catch(() => {
			// Ignore errors — entry may already be gone
		});
	}

	/** Clear only the in-memory timer for a session. */
	#cancelTimer(sessionId: string): void {
		const pending = this.#pendingResumes.get(sessionId);
		if (pending) {
			clearTimeout(pending.timer);
			this.#pendingResumes.delete(sessionId);
		}
	}

	/** Try to resume a session, validating generation and atomically consuming. */
	async #tryResume(session: DeferredSessionInfo, header: SessionHeader, entry: DeferredResumeEntry): Promise<void> {
		try {
			const currentGeneration = header.generation ?? 0;
			if (currentGeneration !== entry.generation) {
				return; // Generation mismatch — stale resume
			}

			const consumed = await this.#callbacks.consumeDeferredResume(session.sessionFile);
			if (!consumed) return;

			this.#callbacks.resumeSession(session.sessionId, entry.generation, entry.model);
		} catch {
			// Resume failed — session may have been deleted or modified
		}
	}

	/** Fire the resume logic when timer expires. */
	async #fireResume(info: DeferredResumeEntry & { sessionId: string; sessionFile: string }): Promise<void> {
		try {
			const header = await this.#callbacks.loadSessionHeader(info.sessionFile);
			if (!header) return; // Session no longer exists

			const currentGeneration = header.generation ?? 0;
			if (currentGeneration !== info.generation) {
				return; // Generation mismatch — stale resume
			}

			const consumed = await this.#callbacks.consumeDeferredResume(info.sessionFile);
			if (!consumed) return;

			this.#callbacks.resumeSession(info.sessionId, info.generation, info.model);
		} catch {
			// Resume failed — session may have been deleted or modified
		}
	}

	/** Get info for all pending resumes. */
	getPendingResumes(): DeferredResumeEntry[] {
		return Array.from(this.#pendingResumes.values()).map(p => p.info);
	}

	/** Check if any resume is pending for a session. */
	hasPendingResume(sessionId: string): boolean {
		return this.#pendingResumes.has(sessionId);
	}

	/** Destroy all timers. */
	destroy(): void {
		for (const [, pending] of this.#pendingResumes) {
			clearTimeout(pending.timer);
		}
		this.#pendingResumes.clear();
	}
}
