/**
 * Centralized type definitions for git-ai VS Code extension.
 * Designed for extensibility to support multiple AI providers (AWS Q, Kiro IDE, etc.)
 */

/**
 * Supported AI providers. Extensible for future providers like Kiro IDE.
 */
export type AIProvider = 'aws-q' | 'kiro' | 'github-copilot' | 'unknown';

/**
 * Event emitted when AI activity is detected from a provider.
 */
export interface AISignalEvent {
  /** Which AI provider generated this signal */
  provider: AIProvider;
  /** Timestamp when the signal was detected */
  timestamp: number;
  /** Optional: File paths affected by the AI edit */
  filePaths?: string[];
  /** Optional: Session ID for grouping related edits */
  sessionId?: string;
  /** Optional: Model name used by the AI */
  model?: string;
}

/**
 * Event for file system changes detected by watchers.
 */
export interface FileChangeEvent {
  /** Type of file system operation */
  type: 'create' | 'change' | 'delete' | 'save';
  /** Absolute path to the file */
  filePath: string;
  /** Timestamp when the change was detected */
  timestamp: number;
}

/**
 * State machine states for checkpoint determination.
 * 
 * Flow:
 * IDLE -> PENDING (file change detected)
 * PENDING -> AI_CONFIRMED (AI signal received before save)
 * PENDING -> HUMAN_CONFIRMED (file saved without AI signal)
 */
export enum CheckpointState {
  /** No pending checkpoint for this file */
  IDLE = 'idle',
  /** File changed, waiting to determine if AI or Human */
  PENDING = 'pending',
  /** AI signal received, waiting for save to execute checkpoint */
  AI_CONFIRMED = 'ai',
  /** No AI signal, checkpoint will be human-authored */
  HUMAN_CONFIRMED = 'human'
}

/**
 * Represents a pending checkpoint waiting to be finalized.
 * The checkpoint type is determined when the file is saved.
 */
export interface PendingCheckpoint {
  /** Absolute path to the changed file */
  filePath: string;
  /** When the file change was first detected */
  changeTimestamp: number;
  /** Whether an AI signal was received for this file */
  aiSignalReceived: boolean;
  /** Whether the file has been saved (triggers checkpoint execution) */
  fileSaved: boolean;
  /** Which AI provider if aiSignalReceived is true */
  provider?: AIProvider;
  /** Session ID from the AI provider */
  sessionId?: string;
  /** Model name from the AI provider */
  model?: string;
  /** Timer for delayed Human decision (race condition handling) */
  decisionTimeout?: NodeJS.Timeout;
}

/**
 * Callback type for AI signal handlers.
 */
export type AISignalHandler = (event: AISignalEvent) => void;

/**
 * Configuration for AI provider detection and behavior.
 */
export interface ProviderConfig {
  /** Unique identifier for the provider */
  id: AIProvider;
  /** VS Code extension ID to detect if installed */
  extensionId?: string;
  /** Display name for logging */
  displayName: string;
  /** Whether this provider uses log file watching */
  usesLogWatching: boolean;
  /** Log file patterns to watch (if usesLogWatching is true) */
  logPatterns?: string[];
  /** Keywords in log lines that indicate AI activity */
  signalKeywords?: string[];
}

/**
 * Registry of known AI providers and their configurations.
 */
export const PROVIDER_CONFIGS: Record<AIProvider, ProviderConfig> = {
  'aws-q': {
    id: 'aws-q',
    extensionId: 'amazonwebservices.amazon-q-vscode',
    displayName: 'Amazon Q',
    usesLogWatching: true,
    logPatterns: ['Amazon Q Logs.log'],
    signalKeywords: ['fsReplace', 'fsWrite', 'fsDelete', 'agenticCodeAccepted']
  },
  'kiro': {
    id: 'kiro',
    extensionId: undefined, // TODO: Add Kiro extension ID when available
    displayName: 'Kiro IDE',
    usesLogWatching: true, // TODO: Confirm Kiro's detection method
    logPatterns: [], // TODO: Add Kiro log patterns
    signalKeywords: [] // TODO: Add Kiro signal keywords
  },
  'github-copilot': {
    id: 'github-copilot',
    extensionId: 'GitHub.copilot',
    displayName: 'GitHub Copilot',
    usesLogWatching: false, // Copilot uses different detection method
    logPatterns: [],
    signalKeywords: []
  },
  'unknown': {
    id: 'unknown',
    displayName: 'Unknown Provider',
    usesLogWatching: false,
    logPatterns: [],
    signalKeywords: []
  }
};

/**
 * Paths and patterns to ignore when watching for file changes.
 */
export const IGNORED_PATHS = [
  '.git',
  '.git-ai',
  'node_modules',
  '.DS_Store',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  'dist',
  'build',
  'out'
];

/**
 * Check if a file path should be ignored for checkpoint tracking.
 */
export function shouldIgnoreFile(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return IGNORED_PATHS.some(ignorePath =>
    normalizedPath.includes(`/${ignorePath}/`) ||
    normalizedPath.endsWith(`/${ignorePath}`) ||
    normalizedPath.endsWith(ignorePath)
  );
}
