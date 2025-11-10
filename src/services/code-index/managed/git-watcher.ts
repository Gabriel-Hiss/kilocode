/**
 * Git-based watcher for managed codebase indexing
 *
 * This module provides a watcher that monitors git state changes (commits and branch switches)
 * instead of file system changes. This avoids infinite loops with .gitignored files and
 * ensures we only index committed changes.
 *
 * The watcher monitors:
 * - Git commits (by watching .git/HEAD and branch refs)
 * - Branch switches (by watching .git/HEAD)
 * - Detached HEAD state (disables indexing)
 */

import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { scanDirectory } from "./scanner"
import { ManagedIndexingConfig, IndexerState } from "./types"
import { getGitHeadPath, getGitState, isDetachedHead, getCurrentBranch } from "./git-utils"
import { getServerManifest } from "./api-client"
import { logger } from "../../../utils/logging"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/**
 * Git state snapshot for change detection
 */
interface GitStateSnapshot {
	branch: string
	commit: string
	isDetached: boolean
}

/**
 * Creates a git-based watcher that monitors git state changes
 *
 * The watcher:
 * - Monitors .git/HEAD for branch switches and commits
 * - Triggers re-indexing after commits (files are naturally committed)
 * - Triggers manifest refresh after branch switches
 * - Disables indexing in detached HEAD state
 *
 * @param config Managed indexing configuration
 * @param context VSCode extension context
 * @param onStateChange Optional callback when git state changes
 * @returns Disposable watcher instance
 */
export function createGitWatcher(
	config: ManagedIndexingConfig,
	context: vscode.ExtensionContext,
	onStateChange?: (state: IndexerState) => void,
): vscode.Disposable {
	console.log("[GitWatcher] ========== CREATING GIT WATCHER ==========")
	console.log("[GitWatcher] Workspace:", config.workspacePath)

	const disposables: vscode.Disposable[] = []
	let currentState: GitStateSnapshot | null = null
	let isProcessing = false

	// Get initial git state
	try {
		const gitState = getGitState(config.workspacePath)
		console.log("[GitWatcher] Git state:", gitState)

		if (gitState) {
			currentState = gitState
			console.log(`[GitWatcher] ✓ Initial state: ${gitState.branch} @ ${gitState.commit.substring(0, 7)}`)
			logger.info(`[GitWatcher] Initial state: ${gitState.branch} @ ${gitState.commit.substring(0, 7)}`)
		} else {
			console.log("[GitWatcher] ⚠ Repository is in detached HEAD state")
			logger.warn("[GitWatcher] Repository is in detached HEAD state - indexing disabled")
			onStateChange?.({
				status: "idle",
				message: "Detached HEAD state - indexing disabled",
				gitBranch: undefined,
			})
		}
	} catch (error) {
		console.error("[GitWatcher] ✗ Failed to get initial git state:", error)
		logger.error(`[GitWatcher] Failed to get initial git state:`, error)
	}

	/**
	 * Handles git state changes
	 */
	const handleGitChange = async () => {
		console.log("[GitWatcher] ========== GIT CHANGE DETECTED ==========")

		if (isProcessing) {
			console.log("[GitWatcher] Already processing, skipping")
			logger.info("[GitWatcher] Already processing, skipping")
			return
		}

		try {
			isProcessing = true

			// Check for detached HEAD
			if (isDetachedHead(config.workspacePath)) {
				console.log("[GitWatcher] Detached HEAD detected - disabling indexing")
				logger.info("[GitWatcher] Detached HEAD detected - disabling indexing")
				currentState = null
				onStateChange?.({
					status: "idle",
					message: "Detached HEAD state - indexing disabled",
					gitBranch: undefined,
				})
				return
			}

			// Get new git state
			const newState = getGitState(config.workspacePath)
			if (!newState) {
				logger.warn("[GitWatcher] Could not determine git state")
				return
			}

			// Check if state actually changed
			if (currentState) {
				const branchChanged = currentState.branch !== newState.branch
				const commitChanged = currentState.commit !== newState.commit

				console.log(`[GitWatcher] State comparison:`)
				console.log(`  Branch: ${currentState.branch} -> ${newState.branch} (changed: ${branchChanged})`)
				console.log(
					`  Commit: ${currentState.commit.substring(0, 7)} -> ${newState.commit.substring(0, 7)} (changed: ${commitChanged})`,
				)

				if (!branchChanged && !commitChanged) {
					console.log("[GitWatcher] No git state change detected")
					logger.info("[GitWatcher] No git state change detected")
					return
				}

				console.log(
					`[GitWatcher] ✓ Git state changed: ${currentState.branch}@${currentState.commit.substring(0, 7)} -> ${newState.branch}@${newState.commit.substring(0, 7)}`,
				)
				logger.info(
					`[GitWatcher] Git state changed: ${currentState.branch}@${currentState.commit.substring(0, 7)} -> ${newState.branch}@${newState.commit.substring(0, 7)}`,
				)

				if (branchChanged) {
					console.log(`[GitWatcher] ✓ Branch changed: ${currentState.branch} -> ${newState.branch}`)
					logger.info(`[GitWatcher] Branch changed: ${currentState.branch} -> ${newState.branch}`)
					await handleBranchChange(newState.branch, config, context, onStateChange)
				} else if (commitChanged) {
					console.log(
						`[GitWatcher] ✓ Commit changed: ${currentState.commit.substring(0, 7)} -> ${newState.commit.substring(0, 7)}`,
					)
					logger.info(
						`[GitWatcher] Commit changed: ${currentState.commit.substring(0, 7)} -> ${newState.commit.substring(0, 7)}`,
					)
					await handleCommit(newState.branch, config, context, onStateChange)
				}
			} else {
				// First time seeing a valid state (recovered from detached HEAD)
				logger.info(`[GitWatcher] Git state established: ${newState.branch}@${newState.commit.substring(0, 7)}`)
				await handleBranchChange(newState.branch, config, context, onStateChange)
			}

			currentState = newState
		} catch (error) {
			logger.error(`[GitWatcher] Error handling git change:`, error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "handleGitChange",
			})
		} finally {
			isProcessing = false
		}
	}

	/**
	 * Handles branch changes - fetches new manifest and re-indexes
	 */
	const handleBranchChange = async (
		newBranch: string,
		config: ManagedIndexingConfig,
		context: vscode.ExtensionContext,
		onStateChange?: (state: IndexerState) => void,
	) => {
		try {
			logger.info(`[GitWatcher] Handling branch change to: ${newBranch}`)

			onStateChange?.({
				status: "scanning",
				message: `Branch changed to ${newBranch}, fetching manifest...`,
				gitBranch: newBranch,
			})

			// Fetch manifest for new branch
			let manifest
			try {
				manifest = await getServerManifest(
					config.organizationId,
					config.projectId,
					newBranch,
					config.kilocodeToken,
				)
				logger.info(
					`[GitWatcher] Fetched manifest for ${newBranch}: ${manifest.totalFiles} files, ${manifest.totalChunks} chunks`,
				)
			} catch (error) {
				logger.warn(`[GitWatcher] No manifest found for ${newBranch}, will perform full scan`)
			}

			// Trigger re-scan with manifest
			onStateChange?.({
				status: "scanning",
				message: `Scanning branch ${newBranch}...`,
				gitBranch: newBranch,
			})

			const result = await scanDirectory(config, context, manifest, (progress) => {
				onStateChange?.({
					status: "scanning",
					message: `Scanning: ${progress.filesProcessed}/${progress.filesTotal} files (${progress.chunksIndexed} chunks)`,
					gitBranch: newBranch,
				})
			})

			if (result.success) {
				// Fetch updated manifest
				let updatedManifest
				try {
					updatedManifest = await getServerManifest(
						config.organizationId,
						config.projectId,
						newBranch,
						config.kilocodeToken,
					)
				} catch (error) {
					logger.warn("[GitWatcher] Failed to fetch updated manifest after scan")
				}

				onStateChange?.({
					status: "watching",
					message: `Branch ${newBranch} indexed successfully`,
					gitBranch: newBranch,
					lastSyncTime: Date.now(),
					totalFiles: result.filesProcessed,
					totalChunks: result.chunksIndexed,
					manifest: updatedManifest
						? {
								totalFiles: updatedManifest.totalFiles,
								totalChunks: updatedManifest.totalChunks,
								lastUpdated: updatedManifest.lastUpdated,
							}
						: undefined,
				})
			} else {
				throw new Error(`Scan failed with ${result.errors.length} errors`)
			}
		} catch (error) {
			logger.error(`[GitWatcher] Failed to handle branch change:`, error)
			onStateChange?.({
				status: "error",
				message: `Failed to index branch ${newBranch}: ${error instanceof Error ? error.message : String(error)}`,
				error: error instanceof Error ? error.message : String(error),
				gitBranch: newBranch,
			})
		}
	}

	/**
	 * Handles commits - re-indexes changed files
	 */
	const handleCommit = async (
		branch: string,
		config: ManagedIndexingConfig,
		context: vscode.ExtensionContext,
		onStateChange?: (state: IndexerState) => void,
	) => {
		try {
			logger.info(`[GitWatcher] Handling commit on branch: ${branch}`)

			onStateChange?.({
				status: "scanning",
				message: `New commit detected, updating index...`,
				gitBranch: branch,
			})

			// Fetch current manifest
			let manifest
			try {
				manifest = await getServerManifest(
					config.organizationId,
					config.projectId,
					branch,
					config.kilocodeToken,
				)
			} catch (error) {
				logger.warn(`[GitWatcher] No manifest found for ${branch}`)
			}

			// Re-scan to pick up committed changes
			const result = await scanDirectory(config, context, manifest, (progress) => {
				onStateChange?.({
					status: "scanning",
					message: `Updating: ${progress.filesProcessed}/${progress.filesTotal} files (${progress.chunksIndexed} chunks)`,
					gitBranch: branch,
				})
			})

			if (result.success) {
				// Fetch updated manifest
				let updatedManifest
				try {
					updatedManifest = await getServerManifest(
						config.organizationId,
						config.projectId,
						branch,
						config.kilocodeToken,
					)
				} catch (error) {
					logger.warn("[GitWatcher] Failed to fetch updated manifest after commit")
				}

				onStateChange?.({
					status: "watching",
					message: `Index updated after commit`,
					gitBranch: branch,
					lastSyncTime: Date.now(),
					totalFiles: result.filesProcessed,
					totalChunks: result.chunksIndexed,
					manifest: updatedManifest
						? {
								totalFiles: updatedManifest.totalFiles,
								totalChunks: updatedManifest.totalChunks,
								lastUpdated: updatedManifest.lastUpdated,
							}
						: undefined,
				})
			} else {
				throw new Error(`Scan failed with ${result.errors.length} errors`)
			}
		} catch (error) {
			logger.error(`[GitWatcher] Failed to handle commit:`, error)
			onStateChange?.({
				status: "error",
				message: `Failed to update index after commit: ${error instanceof Error ? error.message : String(error)}`,
				error: error instanceof Error ? error.message : String(error),
				gitBranch: branch,
			})
		}
	}

	// Watch .git/HEAD file for changes (branch switches and commits)
	try {
		const gitHeadPath = getGitHeadPath(config.workspacePath)
		const absoluteGitHeadPath = path.isAbsolute(gitHeadPath)
			? gitHeadPath
			: path.join(config.workspacePath, gitHeadPath)

		console.log(`[GitWatcher] Setting up watchers...`)
		console.log(`[GitWatcher] Git HEAD path: ${absoluteGitHeadPath}`)
		console.log(`[GitWatcher] File exists: ${fs.existsSync(absoluteGitHeadPath)}`)

		logger.info(`[GitWatcher] Setting up watchers...`)
		logger.info(`[GitWatcher] Git HEAD path: ${absoluteGitHeadPath}`)
		logger.info(`[GitWatcher] File exists: ${fs.existsSync(absoluteGitHeadPath)}`)

		// Use VSCode's file watcher for .git/HEAD
		const headWatcher = vscode.workspace.createFileSystemWatcher(absoluteGitHeadPath)

		disposables.push(
			headWatcher.onDidChange(() => {
				console.log("[GitWatcher] ✓✓✓ .git/HEAD CHANGED - branch switch or commit detected")
				logger.info("[GitWatcher] ✓ .git/HEAD changed - branch switch or commit detected")
				handleGitChange()
			}),
		)

		disposables.push(headWatcher)
		console.log(`[GitWatcher] ✓ Watching .git/HEAD for changes`)
		logger.info(`[GitWatcher] ✓ Watching .git/HEAD for changes`)

		// Watch all branch refs for commits (more reliable than watching individual branch)
		try {
			const gitDir = path.dirname(absoluteGitHeadPath)
			const refsHeadsPattern = path.join(gitDir, "refs", "heads", "**")

			console.log(`[GitWatcher] Branch refs pattern: ${refsHeadsPattern}`)
			logger.info(`[GitWatcher] Branch refs pattern: ${refsHeadsPattern}`)

			const refsWatcher = vscode.workspace.createFileSystemWatcher(refsHeadsPattern)

			disposables.push(
				refsWatcher.onDidChange((uri) => {
					console.log(`[GitWatcher] ✓✓✓ BRANCH REF CHANGED: ${uri.fsPath}`)
					logger.info(`[GitWatcher] ✓ Branch ref changed: ${uri.fsPath}`)
					handleGitChange()
				}),
			)

			disposables.push(refsWatcher)
			console.log(`[GitWatcher] ✓ Watching branch refs for commits`)
			logger.info(`[GitWatcher] ✓ Watching branch refs for commits`)
		} catch (error) {
			console.error(`[GitWatcher] Could not watch branch refs:`, error)
			logger.warn(`[GitWatcher] Could not watch branch refs:`, error)
		}

		// Also watch packed-refs for repositories that use packed refs
		try {
			const gitDir = path.dirname(absoluteGitHeadPath)
			const packedRefsPath = path.join(gitDir, "packed-refs")

			if (fs.existsSync(packedRefsPath)) {
				logger.info(`[GitWatcher] Packed-refs path: ${packedRefsPath}`)
				const packedRefsWatcher = vscode.workspace.createFileSystemWatcher(packedRefsPath)

				disposables.push(
					packedRefsWatcher.onDidChange(() => {
						logger.info("[GitWatcher] ✓ packed-refs changed")
						handleGitChange()
					}),
				)

				disposables.push(packedRefsWatcher)
				logger.info(`[GitWatcher] ✓ Watching packed-refs`)
			} else {
				logger.info(`[GitWatcher] No packed-refs file found (normal for most repos)`)
			}
		} catch (error) {
			logger.warn(`[GitWatcher] Could not watch packed-refs:`, error)
		}
		console.log(`[GitWatcher] ✓ Git watcher setup complete with ${disposables.length} watchers`)
		logger.info(`[GitWatcher] ✓ Git watcher setup complete with ${disposables.length} watchers`)
	} catch (error) {
		console.error(`[GitWatcher] ✗ Failed to create git watcher:`, error)
		logger.error(`[GitWatcher] Failed to create git watcher:`, error)
		TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			location: "createGitWatcher",
		})
	}

	// Add polling as a fallback (VSCode file watchers may not work reliably with .git files)
	console.log(`[GitWatcher] Setting up polling fallback (every 3 seconds)...`)
	const pollingInterval = setInterval(() => {
		console.log("[GitWatcher] [Poll] Checking git state...")
		handleGitChange()
	}, 3000) // Poll every 3 seconds

	disposables.push({
		dispose: () => {
			console.log("[GitWatcher] Stopping polling")
			clearInterval(pollingInterval)
		},
	})

	// Log final setup summary
	console.log(`[GitWatcher] ========== WATCHER INITIALIZED ==========`)
	console.log(`[GitWatcher] Total watchers: ${disposables.length} (including polling)`)
	if (currentState) {
		console.log(`[GitWatcher] Currently tracking: ${currentState.branch} @ ${currentState.commit.substring(0, 7)}`)
		logger.info(`[GitWatcher] Currently tracking: ${currentState.branch} @ ${currentState.commit.substring(0, 7)}`)
	}

	// Return composite disposable
	return vscode.Disposable.from(...disposables)
}
