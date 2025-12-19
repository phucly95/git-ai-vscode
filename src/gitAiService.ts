import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

export class GitAiService {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("Git AI Integration");
    }

    private get gitAiPath(): string {
        const homeDir = os.homedir();
        const defaultPath = path.join(homeDir, '.git-ai', 'bin', 'git-ai');

        if (fs.existsSync(defaultPath)) {
            return defaultPath;
        }
        return 'git-ai'; // Fallback to PATH
    }

    public checkpointHuman() {
        this.runCommand(['checkpoint']);
    }

    public checkpointAwsQ(repoDir: string, filePath?: string) {
        const timestamp = Date.now();

        let editedFilePathsJson = "[]";
        if (filePath && filePath.startsWith(repoDir)) {
            // Calculate relative path 
            // repoDir: /a/b, filePath: /a/b/c/d.txt -> c/d.txt
            let relPath = filePath.substring(repoDir.length);
            if (relPath.startsWith(path.sep)) {
                relPath = relPath.substring(1);
            }
            // Normalize slashes for JSON
            relPath = relPath.replace(/\\/g, '/');
            editedFilePathsJson = JSON.stringify([relPath]);
        }

        const payload = JSON.stringify({
            type: "ai_agent",
            repo_working_dir: repoDir,
            edited_filepaths: JSON.parse(editedFilePathsJson), // Use object not stringified JSON inside JSON
            agent_name: "aws-q",
            model: "aws-q", // Using generic model name
            conversation_id: `vscode-${timestamp}`,
            transcript: {
                messages: []
            }
        });

        // The CLI expects the payload as a string argument
        this.runCommand(['checkpoint', 'agent-v1', '--hook-input', payload], repoDir);
    }

    private runCommand(args: string[], cwd?: string) {
        const executable = this.gitAiPath;

        if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
            this.outputChannel.appendLine(`[WARN] Binary not found at ${executable}`);
            return;
        }

        const workingDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workingDir) {
            return;
        }

        const commandStr = `${executable} ${args.join(' ')}`;
        this.outputChannel.appendLine(`[DEBUG] Executing: ${commandStr}`);

        const child = cp.spawn(executable, args, { cwd: workingDir });

        child.stdout.on('data', (data) => {
            this.outputChannel.appendLine(`[INFO] ${data.toString().trim()}`);
        });

        child.stderr.on('data', (data) => {
            this.outputChannel.appendLine(`[ERROR] ${data.toString().trim()}`);
        });

        child.on('error', (err) => {
            this.outputChannel.appendLine(`[FATAL] Failed to start command: ${err.message}`);
        });
    }
}
