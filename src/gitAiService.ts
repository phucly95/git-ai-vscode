import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

export class GitAiService {
    private outputChannel: vscode.OutputChannel;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Integration");
    }

    public getBinaryResolution(): { path: string, source: 'bundled' | 'global' | 'path' } {
        // 1. Try bundled binary (Priority for Extension)
        const platform = os.platform();
        const arch = os.arch();
        let binaryName = '';

        if (platform === 'darwin') {
            binaryName = arch === 'arm64' ? path.join('macos-arm64', 'git-ai') : path.join('macos-intel', 'git-ai');
        } else if (platform === 'win32') {
            binaryName = path.join('windows-x64', 'git-ai.exe');
        }

        if (binaryName) {
            const bundledPath = path.join(this.context.extensionPath, 'bin', binaryName);
            if (fs.existsSync(bundledPath)) {
                // Try to ensure execution permissions on Unix-like systems
                if (platform !== 'win32') {
                    try {
                        fs.chmodSync(bundledPath, 0o755);
                    } catch (err) {
                        console.error(`[WARN] Failed to chmod ${bundledPath}:`, err);
                    }
                }
                return { path: bundledPath, source: 'bundled' };
            } else {
                console.log(`[DEBUG] Bundled binary not found at: ${bundledPath}`);
            }
        }

        // 2. Fallback to existing logic (global install or relative path)
        const homeDir = os.homedir();
        const defaultPath = path.join(homeDir, '.git-ai', 'bin', 'git-ai');

        if (fs.existsSync(defaultPath)) {
            return { path: defaultPath, source: 'global' };
        }
        return { path: 'git-ai', source: 'path' };
    }

    private get gitAiPath(): string {
        return this.getBinaryResolution().path;
    }

    public async isCliInstalled(): Promise<boolean> {
        const homeDir = os.homedir();
        // Check common locations
        const locations = [
            path.join(homeDir, '.git-ai', 'bin', 'git-ai'),
            path.join(homeDir, '.local', 'bin', 'git-ai'),
            '/usr/local/bin/git-ai',
            path.join(homeDir, '.cargo', 'bin', 'git-ai')
        ];

        for (const loc of locations) {
            if (fs.existsSync(loc)) {
                return true;
            }
        }
        return false;
    }

    public async isShimInstalled(): Promise<boolean> {
        const homeDir = os.homedir();
        const shimDir = path.join(homeDir, '.git-ai', 'bin');
        const gitShim = path.join(shimDir, 'git');
        const gitOgShim = path.join(shimDir, 'git-og');
        const configPath = path.join(homeDir, '.git-ai', 'config.json');

        if (fs.existsSync(gitShim) && fs.existsSync(gitOgShim) && fs.existsSync(configPath)) {
            // Validate Config: If it points to 'git-og' OR to a shim path, it's broken.
            try {
                const configContent = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(configContent);

                // Check 1: Old 'git-og' reference
                if (config.git_path && config.git_path.includes('git-og')) {
                    return false;
                }

                // Check 2: Self-Reference (Recursion Risk)
                // If the configured git_path is inside our own shim directories, IT IS BROKEN.
                if (config.git_path) {
                    const normalized = path.resolve(config.git_path);
                    const badPaths = [
                        path.join(homeDir, '.git-ai'),
                        path.join(homeDir, '.local', 'bin')
                    ];
                    if (badPaths.some(bp => normalized.startsWith(bp))) {
                        console.warn(`[Git AI] Detected recursive config pointing to ${normalized}. Forcing reinstall.`);
                        return false;
                    }
                }

                return true;
            } catch (err) {
                // Config unreadable? re-install.
                return false;
            }
        }
        return false;
    }

    public async installBundledCli(): Promise<string> {
        const resolution = this.getBinaryResolution();
        if (resolution.source !== 'bundled') {
            throw new Error("No bundled binary found to install.");
        }

        const sourcePath = resolution.path;
        const homeDir = os.homedir();
        // Default target: ~/.git-ai/bin/git-ai
        const targetDir = path.join(homeDir, '.git-ai', 'bin');
        const targetPath = path.join(targetDir, 'git-ai');

        if (!fs.existsSync(targetDir)) {
            try {
                fs.mkdirSync(targetDir, { recursive: true });
            } catch (err) {
                throw new Error(`Could not create ${targetDir}. Please create it manually.`);
            }
        }

        // Copy file
        try {
            fs.copyFileSync(sourcePath, targetPath);
            if (os.platform() !== 'win32') {
                fs.chmodSync(targetPath, 0o755);
            }
        } catch (err: any) {
            throw new Error(`Failed to copy binary to ${targetPath}: ${err.message}`);
        }

        return targetPath;
    }

    public async installGlobalShim(): Promise<string> {
        const resolution = this.getBinaryResolution();
        if (resolution.source !== 'bundled') {
            throw new Error("No bundled binary found to install.");
        }

        const sourcePath = resolution.path;
        const homeDir = os.homedir();
        const targetDir = path.join(homeDir, '.git-ai', 'bin');

        if (!fs.existsSync(targetDir)) {
            try {
                fs.mkdirSync(targetDir, { recursive: true });
            } catch (err) {
                throw new Error(`Could not create ${targetDir}. Please create it manually.`);
            }
        }

        // 1. Identify Real Git
        const gitShimPath = path.join(targetDir, 'git');
        const gitAiDestPath = path.join(targetDir, 'git-ai');

        const realGitPath = await this.findRealGitPath();
        if (!realGitPath) {
            throw new Error("Could not find a standard 'git' executable to shim.");
        }

        // 2. Install git-ai binary if not present (or update it)
        try {
            fs.copyFileSync(sourcePath, gitAiDestPath);
            if (os.platform() !== 'win32') {
                fs.chmodSync(gitAiDestPath, 0o755);
            }
        } catch (err: any) {
            throw new Error(`Failed to copy git-ai to ${gitAiDestPath}: ${err.message}`);
        }

        // 3. Create 'git' symlink -> git-ai
        try {
            if (fs.existsSync(gitShimPath)) {
                fs.unlinkSync(gitShimPath);
            }
            fs.symlinkSync(gitAiDestPath, gitShimPath);
        } catch (err: any) {
            throw new Error(`Failed to create git shim symlink: ${err.message}`);
        }

        // 3a. Create 'git-og' symlink -> real git
        const gitOgShimPath = path.join(targetDir, 'git-og');
        try {
            if (fs.existsSync(gitOgShimPath)) {
                fs.unlinkSync(gitOgShimPath);
            }

            // Create a Wrapper Script instead of a Symlink
            // This avoids "cannot handle og as a builtin" errors from Git.
            if (os.platform() === 'win32') {
                // Windows Batch Script
                const batchContent = `@echo off\r\n"${realGitPath}" %*`;
                // Note: Windows shim should probably be .cmd or .bat
                // But if we stick to 'git-og' (no ext) in strict environments, it might fail.
                // For now, let's create 'git-og.cmd' as main, and 'git-og' as sh fallback if needed?
                // Actually, just 'git-og' file with no ext on windows is useless.
                // Let's create 'git-og.cmd' AND 'git-og' (sh) for git bash users.

                fs.writeFileSync(gitOgShimPath + '.cmd', batchContent);
                // Also create shell script for Bash on Windows
                const shContent = `#!/bin/sh\nexec "${realGitPath.replace(/\\/g, '/')}" "$@"\n`;
                fs.writeFileSync(gitOgShimPath, shContent);
            } else {
                // Unix Shell Script
                const shContent = `#!/bin/sh\nexec "${realGitPath}" "$@"\n`;
                fs.writeFileSync(gitOgShimPath, shContent);
                fs.chmodSync(gitOgShimPath, 0o755);
            }
        } catch (err: any) {
            // Non-critical but good to warn
            console.warn(`[Git AI] Failed to create git-og shim: ${err.message}`);
        }

        // 4. Create/Update Config (~/.git-ai/config.json)
        const configDir = path.join(homeDir, '.git-ai');
        const configPath = path.join(configDir, 'config.json');

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        // Use absolute path to real git, preventing "cannot handle og as builtin" error
        const configContent = {
            git_path: realGitPath
        };

        try {
            fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2));
        } catch (err: any) {
            throw new Error(`Failed to write config file ${configPath}: ${err.message}`);
        }

        // 5. Configure VS Code git.path
        await this.checkAndConfigureGitPath(gitShimPath);

        return targetDir;
    }

    public async checkAndConfigureGitPath(shimPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('git');
        const currentPath = config.get<string>('path');

        // Normalize paths for comparison
        const normShimPath = path.resolve(shimPath);
        const normCurrentPath = currentPath ? path.resolve(currentPath) : null;

        if (normCurrentPath !== normShimPath) {
            console.log(`[Git AI] Updating git.path from '${currentPath}' to '${shimPath}'`);
            try {
                // Update Global Settings (User Level)
                await config.update('path', shimPath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Git AI: Updated VS Code 'git.path' to use the shim.`);
            } catch (error) {
                console.error(`[Git AI] Failed to update git.path:`, error);
                vscode.window.showErrorMessage(`Git AI: Failed to configure 'git.path'. Please manually set it to: ${shimPath}`);
            }
        }
    }

    private async findRealGitPath(): Promise<string | null> {
        // Logic to find 'git' that is NOT our shim
        // We can shell out to 'which -a git' (unix) or 'where git' (win) and pick first one that isn't ~/.local/bin/git
        const cmd = os.platform() === 'win32' ? 'where git' : 'which -a git';

        return new Promise((resolve) => {
            const child_process = require('child_process');
            child_process.exec(cmd, (err: any, stdout: string) => {
                if (err) {
                    resolve(null);
                    return;
                }
                const lines = stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
                const homeDir = os.homedir();

                // Dynamic exclusion: Exclude ANY path that contains .git-ai or .local/bin
                // This ensures we don't accidentally pick up our own shims or broken symlinks
                const excludePatterns = [
                    path.join(homeDir, '.git-ai'),
                    path.join(homeDir, '.local', 'bin')
                ];

                for (const line of lines) {
                    const p = line.trim();
                    const isShim = excludePatterns.some(pattern => p.startsWith(pattern));

                    if (isShim || p.includes('git-ai')) {
                        continue;
                    }

                    // ULTIMATE SAFETY CHECK: Resolve Symlinks
                    // If 'p' is a symlink that points to 'git-ai', we MUST skip it.
                    try {
                        const resolved = fs.realpathSync(p);
                        const basename = path.basename(resolved).toLowerCase();
                        if (basename === 'git-ai' || basename === 'git-ai.exe') {
                            // It points to us. Skip!
                            continue;
                        }

                        // Verify it's actually executable
                        fs.accessSync(p, fs.constants.X_OK);

                        // If we got here, it's a valid candidate (not us, executable)
                        resolve(p);
                        return;
                    } catch (e) {
                        // Skip if not resolvable or not executable
                    }
                }
                resolve(null);
            });
        });
    }

    public async configureShellPath(): Promise<void> {
        if (os.platform() === 'win32') {
            return;
        }

        const homeDir = os.homedir();

        // Potential RC files to update
        const rcFiles: string[] = [];

        // 1. Check SHELL env var
        const shell = process.env.SHELL;
        if (shell) {
            if (shell.includes('zsh')) {
                rcFiles.push(path.join(homeDir, '.zshrc'));
            } else if (shell.includes('bash')) {
                rcFiles.push(os.platform() === 'darwin' ? path.join(homeDir, '.bash_profile') : path.join(homeDir, '.bashrc'));
            }
        }

        // 2. Fallback: Check common files if they exist or if SHELL is unknown/unset
        if (rcFiles.length === 0) {
            const commonFiles = ['.zshrc', '.bash_profile', '.bashrc', '.profile'];
            for (const f of commonFiles) {
                const p = path.join(homeDir, f);
                if (fs.existsSync(p)) {
                    rcFiles.push(p);
                }
            }
        }

        // 3. Fallback: If absolutely nothing exists, pick a default to create
        if (rcFiles.length === 0) {
            if (os.platform() === 'darwin') {
                rcFiles.push(path.join(homeDir, '.zshrc'));
            } else {
                rcFiles.push(path.join(homeDir, '.bashrc'));
            }
        }

        // De-duplicate
        const uniqueRcFiles = [...new Set(rcFiles)];
        let updated = false;

        for (const rcFile of uniqueRcFiles) {
            try {
                // Create if not exists
                if (!fs.existsSync(rcFile)) {
                    fs.writeFileSync(rcFile, '');
                }

                const content = fs.readFileSync(rcFile, 'utf8');
                // Check if our SPECIFIC export is already there to avoid false positives (e.g. .local/bin/env)
                if (content.includes('export PATH="$HOME/.git-ai/bin:$PATH"')) {
                    continue;
                }

                // Append export
                this.outputChannel.appendLine(`[INFO] Appending git-ai shim path to ${rcFile}`);
                const exportLine = `\n# Added by git-ai-vscode to ensure correct attribution\nexport PATH="$HOME/.git-ai/bin:$PATH"\n`;
                fs.appendFileSync(rcFile, exportLine);
                updated = true;
            } catch (error: any) {
                console.error(`[Git AI] Failed to configure ${rcFile}:`, error);
                this.outputChannel.appendLine(`[ERROR] Failed to configure ${rcFile}: ${error.message}`);
            }
        }

        if (updated) {
            vscode.window.showInformationMessage(`Git AI: Updated shell configuration to use git-ai shim.`);
        }
    }

    public checkpointHuman(filePath?: string): Promise<void> {
        let cwd: string | undefined;
        if (filePath) {
            cwd = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath;
        }
        return this.runCommand(['checkpoint'], cwd);
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
        return this.runCommand(['checkpoint', 'agent-v1', '--hook-input', payload], repoDir);
    }

    private runCommand(args: string[], cwd?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const executable = this.gitAiPath;

            if (path.isAbsolute(executable) && !fs.existsSync(executable)) {
                this.outputChannel.appendLine(`[WARN] Binary not found at ${executable}`);
                return reject(new Error(`Binary not found at ${executable}`));
            }

            const workingDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workingDir) {
                return reject(new Error("No working directory found"));
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
                reject(err);
            });

            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    this.outputChannel.appendLine(`[ERROR] Command failed with exit code ${code}. Command: ${commandStr}`);
                    reject(new Error(`Command failed with exit code ${code}`));
                }
            });
        });
    }
}
