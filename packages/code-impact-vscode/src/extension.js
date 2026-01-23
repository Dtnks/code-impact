const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { execSync } = require('child_process');
const { FormData, File } = require('undici');

const { DifyClient } = require('./dify-client');
function inferMimeByExt(filePath) {
    const base = path.basename(filePath).toLowerCase();
    const ext = (path.extname(filePath) || '').toLowerCase();
    if (base.startsWith('graph') || ext === '.json') return 'application/json';
    if (ext === '.txt' || ext === '.mmd' || base.includes('impact')) return 'text/plain';
    return 'application/octet-stream';
}

const output = vscode.window.createOutputChannel('Code Impact');
let lastImpactCache = null; // { mmd, seeds, results, edges, direction, depth, includeDynamic, settings }
let bgFilesCache = []; // { path, size, content, truncated }
let sidebarWebview = null;
let conversationId = null;
let conversationHistory = []; // [{role:'user'|'assistant', text}]

async function loadCore() {
    try {
        const corePath = path.resolve(__dirname, '../../code-impact/src/index.js');
        const core = await import(corePath);
        return {
            buildGraph: core.buildGraph,
            saveGraph: core.saveGraph,
            loadGraph: core.loadGraph,
            traverseImpact: core.traverseImpact,
            getChangedFiles: core.getChangedFiles,
            getChangedRanges: core.getChangedRanges,
        };
    } catch (err) {
        output.appendLine(`loadCore failed: ${err?.stack || err}`);
        throw err;
    }
}

function filterTargets(list = []) {
    return list.filter((p) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.includes('/.code-impact/')) return false;
        if (norm.endsWith('impact.txt')) return false;
        if (norm.endsWith('impactCode.txt')) return false;
        return true;
    });
}

function showInfo(message) {
    vscode.window.setStatusBarMessage(message, 3000);
}

async function ensureWorkspaceFolder() {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws || ws.length === 0) {
        vscode.window.showErrorMessage('未找到工作区，请先打开项目。');
        throw new Error('no workspace');
    }
    return ws[0].uri.fsPath;
}

function execGit(command, cwd) {
    return execSync(`git ${command}`, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
    }).trim();
}

function collectGitContext(root, range) {
    if (!range) return null;
    try {
        const diff = execGit(`diff ${range}`, root);
        const changedRaw = execGit(`diff --name-status ${range}`, root);
        const statsRaw = execGit(`diff --stat ${range}`, root);
        const files = { added: [], modified: [], deleted: [], renamed: [] };
        (changedRaw || '').split('\n').filter(Boolean).forEach((line) => {
            const [status, ...fileParts] = line.split('\t');
            const file = fileParts.join('\t');
            switch (status?.[0]) {
                case 'A':
                    files.added.push(file);
                    break;
                case 'M':
                    files.modified.push(file);
                    break;
                case 'D':
                    files.deleted.push(file);
                    break;
                case 'R':
                    files.renamed.push({ from: fileParts[0], to: fileParts[1] });
                    break;
                default:
                    break;
            }
        });
        const summaryLine = (statsRaw || '').split('\n').pop() || '';
        const filesMatch = summaryLine.match(/(\d+) files? changed/);
        const insertionsMatch = summaryLine.match(/(\d+) insertions?\(\+\)/);
        const deletionsMatch = summaryLine.match(/(\d+) deletions?\(-\)/);
        const stats = {
            filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
            insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
            deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
            raw: statsRaw,
        };
        return { diff, files, stats, range };
    } catch (err) {
        output.appendLine(`collectGitContext error: ${err?.message || err}`);
        vscode.window.showWarningMessage(`获取 Git diff 失败: ${err?.message || err}`);
        return null;
    }
}

async function fileExists(p) {
    try {
        const st = await fsp.stat(p);
        return st.isFile();
    } catch {
        return false;
    }
}

async function appendFile(formData, field, filePath, displayName) {
    if (!filePath || !formData) return false;
    const exists = await fileExists(filePath);
    if (!exists) return false;
    const buf = await fsp.readFile(filePath);
    const file = new File([buf], displayName || path.basename(filePath), { type: 'application/octet-stream' });
    formData.append(field, file);
    return true;
}

function findGraphPath(root) {
    const candidates = [
        path.join(root, '.code-impact', 'graph.txt'),
        path.join(root, 'graph.txt'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

async function runBuildGraph(root) {
    const { buildGraph, saveGraph } = await loadCore();
    // 优先使用选定目录下的 src，若不存在则使用选定目录本身
    let roots = [];
    const candidate = path.join(root, 'src');
    try {
        const stat = await fsp.stat(candidate);
        if (stat.isDirectory()) roots.push('src');
    } catch {
        // ignore
    }
    if (roots.length === 0) {
        roots = ['.'];
    }
    const graph = await buildGraph({ projectRoot: root, roots });
    const out = await saveGraph(graph, root);
    vscode.window.showInformationMessage(`依赖图已生成: ${out}`);
}

function toMermaid({ seeds, results, edges, direction = 'reverse' }) {
    const ids = new Set();
    [...(seeds || []), ...(results || []).map((r) => r.id)].forEach((id) => {
        if (id) ids.add(id);
    });
    (edges || []).forEach((e) => {
        if (e?.from) ids.add(e.from);
        if (e?.to) ids.add(e.to);
    });
    const idMap = new Map();
    let idx = 0;
    ids.forEach((id) => idMap.set(id, `n${idx++}`));

    const lines = ['graph LR'];
    ids.forEach((id) => {
        const label = String(id).replace(/"/g, '\\"');
        lines.push(`  ${idMap.get(id)}["${label}"]`);
    });
    (edges || []).forEach((e) => {
        if (!e?.from || !e?.to) return;
        const forwardFrom = direction === 'reverse' ? e.to : e.from;
        const forwardTo = direction === 'reverse' ? e.from : e.to;
        const from = idMap.get(forwardFrom);
        const to = idMap.get(forwardTo);
        if (!from || !to) return;
        const dyn = e.dynamic ? '|dynamic|' : '';
        lines.push(`  ${from} -->${dyn} ${to}`);
    });
    const seedIds = (seeds || []).map((s) => idMap.get(s)).filter(Boolean);
    const impactIds = (results || []).map((r) => idMap.get(r.id)).filter(Boolean);
    lines.push('  classDef seed fill:#ffd166,stroke:#d49b00,stroke-width:1.5px;');
    lines.push('  classDef impact fill:#ef476f,color:#fff;');
    if (seedIds.length) lines.push(`  class ${seedIds.join(',')} seed;`);
    if (impactIds.length) lines.push(`  class ${impactIds.join(',')} impact;`);
    return lines.join('\n');
}

async function showMermaid(content, title = 'impact.mmd') {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
    showInfo(`${title} 已生成（可用 Mermaid 预览插件查看）`);
    await showMermaidPreview(content, title);
}

async function collectCodeSnippets(root, files, { maxFiles = 5, maxLines = 200, rangesMap = {} } = {}) {
    const normKey = (p) => {
        if (!p) return p;
        let k = p.replace(/^a\//, '').replace(/^b\//, '').replace(/^\.?\//, '');
        if (path.isAbsolute(k)) {
            const rel = path.relative(root, k);
            if (rel && !rel.startsWith('..')) k = rel;
        }
        if (k.startsWith('../')) k = k.replace(/^\.\.\//, '');
        k = k.split(path.sep).join('/'); // posix normalize
        return k;
    };
    const snippets = [];
    const picked = Array.from(new Set(files)).slice(0, maxFiles);
    for (const f of picked) {
        if (!f || f.startsWith('pkg:')) continue;
        const abs = path.isAbsolute(f) ? f : path.join(root, f);
        try {
            const buf = await fsp.readFile(abs, 'utf8');
            const lines = buf.split(/\r?\n/);
            const key = normKey(f);
            const relKey = normKey(path.relative(root, abs));
            const ranges = rangesMap[key] || rangesMap[relKey] || [];
            if (ranges.length) {
                const contents = [];
                const changeLines = [];
                for (const r of ranges) {
                    const start = Math.max(1, r.start);
                    const end = Math.min(lines.length, r.end);
                    if (end < start) continue;
                    contents.push(lines.slice(start - 1, end).join('\n'));
                    changeLines.push({ start, end });
                }
                snippets.push({
                    path: f,
                    lines: lines.length,
                    truncated: false,
                    changeLines,
                    contents,
                });
            } else {
                const truncated = lines.length > maxLines;
                const content = lines.slice(0, maxLines).join('\n');
                snippets.push({ path: f, lines: lines.length, truncated, contents: [content], changeLines: [] });
            }
        } catch (err) {
            output.appendLine(`读取代码片段失败 ${f}: ${err?.message || err}`);
        }
    }
    return snippets;
}

async function saveImpactOutputs(root, { mmd, seeds, results, edges, codeSnippets }) {
    try {
        const mmdUri = vscode.Uri.file(path.join(root, 'impact.txt'));
        const jsonUri = vscode.Uri.file(path.join(root, 'impactCode.txt'));
        await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(mmd, 'utf8'));
        await vscode.workspace.fs.writeFile(
            jsonUri,
            Buffer.from(
                JSON.stringify(
                    {
                        seeds,
                        results,
                        edges,
                        codeSnippets,
                        generatedAt: new Date().toISOString(),
                    },
                    null,
                    2
                ),
                'utf8'
            )
        );
        output.appendLine(`已自动保存 impact.txt 与 impactCode.txt 至: ${root}`);
    } catch (err) {
        output.appendLine(`保存结果文件失败: ${err?.stack || err}`);
        vscode.window.showWarningMessage(`保存结果文件失败: ${err?.message || err}`);
    }
}

async function readBgFiles(paths = []) {
    const files = [];
    for (const p of paths) {
        try {
            const stat = await fsp.stat(p);
            if (!stat.isFile()) continue;
            const size = stat.size;
            let truncated = false;
            let content = '';
            if (size > MAX_BG_FILE_BYTES) {
                const buf = await fsp.readFile(p, { encoding: 'utf8' });
                content = buf.slice(0, MAX_BG_FILE_BYTES);
                truncated = true;
            } else {
                content = await fsp.readFile(p, 'utf8');
            }
            files.push({ path: p, size, content, truncated });
        } catch (err) {
            output.appendLine(`readBgFiles skip ${p}: ${err?.message || err}`);
        }
    }
    bgFilesCache = files;
    return files;
}

function toMermaidWebviewHtml(webview, mmd, title = 'Impact Preview') {
    const nonce = getNonce();
    const mmdJson = JSON.stringify(mmd || '');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
  <style>
    body { margin: 0; padding: 12px; background: #111; color: #eee; }
    #app { width: 100%; }
    pre { color: #bbb; }
  </style>
</head>
<body>
  <div id="app">加载中...</div>
  <script nonce="${nonce}" type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    const mmd = ${mmdJson};
    mermaid.initialize({ startOnLoad: false, theme: 'white' });
    const el = document.getElementById('app');
    mermaid.render('impact-graph', mmd).then(({ svg }) => {
      el.innerHTML = svg;
    }).catch((err) => {
      el.innerHTML = '<pre>渲染失败: ' + (err?.message || err) + '</pre>';
      console.error(err);
    });
  </script>
</body>
</html>`;
}

async function showMermaidPreview(content, title = 'Impact Preview') {
    try {
        const panel = vscode.window.createWebviewPanel(
            'codeImpact.mermaidPreview',
            title,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );
        panel.webview.html = toMermaidWebviewHtml(panel.webview, content, title);
    } catch (err) {
        output.appendLine(`showMermaidPreview error: ${err?.stack || err}`);
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

async function runImpact({ gitRange, depth = 4, includeDynamic = true, mermaid = true, root, direction = 'reverse', settings = {} }) {
    const { loadGraph, traverseImpact, getChangedFiles, getChangedRanges } = await loadCore();
    const workspaceRoot = root || await ensureWorkspaceFolder();
    let targets = [];
    if (gitRange) {
        targets = getChangedFiles({ projectRoot: workspaceRoot, range: gitRange });
    }else{
        vscode.window.showWarningMessage('未输入比较范围');
        return 
    }
    targets = filterTargets(targets);
    if (targets.length === 0) {
        vscode.window.showWarningMessage('未找到有效的变更文件（可能被忽略规则过滤）。');
        return;
    }

    const graph = await loadGraph(workspaceRoot);
    let rangesMap = {};
    try {
        rangesMap = getChangedRanges({ projectRoot: workspaceRoot, range: gitRange, files: targets });
    } catch {
        rangesMap = {};
    }
    
    const { results, edges, seeds } = traverseImpact(graph, targets, {
        includeDynamic,
        depth: Number.isFinite(depth) ? depth : Infinity,
    });

    const mmd = toMermaid({ seeds, results, edges, direction });
    const codeFiles = [...(seeds || []), ...(results || []).map((r) => r.id)];
    const codeSnippets = await collectCodeSnippets(workspaceRoot, codeFiles, {
        maxFiles: settings.codeMaxFiles || 5,
        maxLines: settings.codeMaxLines || 200,
        rangesMap,
    });
    output.appendLine(`rangesMap keys: ${Object.keys(rangesMap).join(',') || '(empty)'}; files matched: ${codeFiles.join(',')}`);
    await saveImpactOutputs(workspaceRoot, { mmd, seeds, results, edges, codeSnippets });

    lastImpactCache = {
        mmd,
        seeds,
        results,
        edges,
        codeSnippets,
        direction,
        depth,
        includeDynamic,
        root: workspaceRoot,
        gitRange: gitRange || null,
        source: gitRange ? 'git' : 'files',
        targets,
        settings: {
            includeMmd: true,
            includeCode: true,
            includeDynamic,
            codeMaxFiles: settings.codeMaxFiles || 5,
            codeMaxLines: settings.codeMaxLines || 200,
            codeSnippetsCount: codeSnippets.length,
        }
    };
    if (mermaid) {
        await showMermaid(mmd);
    } else {
        const lines = results.map((r) => `${r.distance}\t${r.type}\t${r.id}`);
        await showMermaid(lines.join('\n'), 'impact.txt');
    }
}

function parseDifyOutputs(outputs) {
    if (!outputs) return null;
    try {
        if (typeof outputs === 'string') return JSON.parse(outputs);
        return {
            requirementComparison: outputs.requirement_comparison || outputs.requirementComparison || null,
            impactAnalysis: outputs.impact_analysis || outputs.impactAnalysis || null,
            risks: outputs.risks || [],
            testSuggestions: outputs.test_suggestions || outputs.testSuggestions || [],
            summary: outputs.summary || '',
        };
    } catch (err) {
        output.appendLine(`parseDifyOutputs failed: ${err?.message || err}`);
        return null;
    }
}

async function handleAI(payload = {}) {
    try {
        // const prd = payload?.prd || '';
        const root = lastImpactCache?.root || await ensureWorkspaceFolder();
        const gitRange = lastImpactCache?.gitRange;
        const apiKey = process.env.DIFY_API_KEY || undefined;
        const baseUrl = process.env.DIFY_BASE_URL || undefined;
        const query = (payload?.query || '').trim() || '请根据提供的上下文进行影响分析并给出结果。';
        if (!apiKey) {
            vscode.window.showWarningMessage('未配置 DIFY_API_KEY，使用内置默认密钥调用。');
            output.appendLine('DIFY_API_KEY 未配置，将使用内置默认密钥。');
        }

        const impactPath = path.join(root, 'impact.txt');
        const codePath = path.join(root, 'impactCode.txt');
        const graphPath = findGraphPath(root);
        const gitContext = gitRange ? collectGitContext(root, gitRange) : null;
        const impactCache = lastImpactCache;

        const client = new DifyClient({ baseUrl, apiKey });

        const readTextIfExists = async (p) => {
            try {
                return await fsp.readFile(p, 'utf8');
            } catch {
                return '';
            }
        };

        const readJsonIfExists = async (p) => {
            try {
                const txt = await fsp.readFile(p, 'utf8');
                return JSON.parse(txt);
            } catch {
                return null;
            }
        };

        const toStr = (v) => {
            if (v === undefined || v === null) return undefined;
            if (typeof v === 'string') return v;
            try {
                return JSON.stringify(v);
            } catch {
                return String(v);
            }
        };

        const inputsObj = {};
        let attached = 0;

        const codeImpactContent = await readTextIfExists(impactPath);
        if (codeImpactContent) {
            inputsObj.codeImpactMmd = toStr(codeImpactContent);
        }

        const codeJson = await readJsonIfExists(codePath);
        if (codeJson) {
            inputsObj.code = toStr(codeJson);
            attached++;
        }

        const graphJson = graphPath ? await readJsonIfExists(graphPath) : null;
        if (graphJson) {
            inputsObj.AST = toStr(graphJson);
            attached++;
        }

        // 不再上传 codeSnippets / gitContext，首调仅传核心上下文

        // const prdArr = [];
        // for (const f of bgFilesCache) {
        //     const id = await uploadIfExists(f.path, path.basename(f.path), inferMimeByExt(f.path));
        //     if (id) {
        //         prdArr.push(toFileInput(id, path.basename(f.path)));
        //         attached++;
        //     }
        // }
        // if (prd && prd.trim()) {
        //     const id = await client.uploadFile({ content: Buffer.from(prd, 'utf8'), fileName: 'prd.txt', mime: 'text/plain' });
        //     if (id) {
        //         prdArr.push(toFileInput(id, 'prd.txt'));
        //         attached++;
        //     }
        // }
        // if (prdArr.length) inputsObj.prd = prdArr;

        // 不再上传 git_range

        // 用户输入作为 question 传给 Agent
        inputsObj.question = toStr(query);

        if (!inputsObj.codeImpactMmd || attached === 0) {
            vscode.window.showWarningMessage('缺少必需的上下文（codeImpactMmd 或 code/AST），请先运行影响分析。');
            return;
        }

        const lens = Object.entries(inputsObj).map(([k, v]) => {
            const str = typeof v === 'string' ? v : '';
            return `${k}:${str.length}`;
        }).join(', ');
        output.appendLine(`AI 调用开始: gitRange=${gitRange || '(none)'}, keys=${Object.keys(inputsObj).join(',')}, lens=(${lens})`);

        // 通知侧边栏禁用按钮
        sidebarWebview?.postMessage({ type: 'aiRunning', running: true });

        const stream = await client.runAgent({
            inputs: inputsObj,
            user: 'code-impact-vscode',
            query,
            stream: true,
            conversationId,
        });
        const reader = stream.getReader ? stream.getReader() : stream;
        const decoder = new TextDecoder();
        let buffer = '';
        let finalText = '';
        const thoughtLogs = [];
        sidebarWebview?.postMessage({ type: 'aiThought', text: '模型思考中...' });
        output.appendLine('AI 流式开始...');

        const flush = () => {
            const parts = buffer.split('\n');
            buffer = parts.pop();
            for (const line of parts) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.replace(/^data:\s*/, '');
                if (data === '[DONE]') {
                    sidebarWebview?.postMessage({ type: 'final', text: finalText });
                    return 'done';
                }
                try {
                    const obj = JSON.parse(data);
                    if (obj?.conversation_id) {
                        conversationId = obj.conversation_id;
                    }
                    // Agent 思考
                    if (obj?.event === 'agent_thought' && obj?.content) {
                        sidebarWebview?.postMessage({ type: 'aiThought', text: obj.content });
                        thoughtLogs.push(obj.content);
                        continue;
                    }
                    // 普通消息片段
                    if (obj?.event === 'message' && obj?.answer !== undefined) {
                        finalText += obj.answer || '';
                        sidebarWebview?.postMessage({ type: 'aiThought', text: finalText });
                        continue;
                    }
                    // 最终消息
                    if (obj?.event === 'message_end' && obj?.answer !== undefined) {
                        finalText = obj.answer || finalText;
                        sidebarWebview?.postMessage({ type: 'aiThought', text: finalText });
                        continue;
                    }
                    if (obj?.event === 'error') {
                        const msg = obj?.message || 'Agent 调用错误';
                        sidebarWebview?.postMessage({ type: 'error', text: msg });
                        output.appendLine(`Agent error: ${msg}`);
                        continue;
                    }
                } catch {
                    // 非 JSON，视为正文
                    finalText += data;
                    sidebarWebview?.postMessage({ type: 'aiThought', text: finalText });
                }
            }
            return null;
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const status = flush();
                if (status === 'done') break;
            }
            flush();
            conversationHistory.push({ role: 'user', text: query });
            conversationHistory.push({ role: 'assistant', text: finalText || '(空)' });
            sidebarWebview?.postMessage({ type: 'chatHistory', conversationId, history: conversationHistory });
            sidebarWebview?.postMessage({ type: 'aiFinal', text: finalText || '' });
            sidebarWebview?.postMessage({ type: 'aiRunning', running: false });
            output.appendLine('AI 流式结束');
            showInfo('Dify 分析完成（流式）');
        } catch (err) {
            sidebarWebview?.postMessage({ type: 'error', text: err?.message || String(err) });
            throw err;
        }
    } catch (err) {
        output.appendLine(`handleAI error: ${err?.stack || err}`);
        vscode.window.showErrorMessage(`AI 分析失败: ${err?.message || err}`);
        sidebarWebview?.postMessage({ type: 'aiRunning', running: false });
    }
}

function activate(context) {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('codeImpact.sidebar', new CodeImpactSidebarProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
    output.appendLine('Code Impact extension activated');
}

function deactivate() { }

module.exports = {
    activate,
    deactivate,
};

// Sidebar view provider
class CodeImpactSidebarProvider {
    constructor(context) {
        this.context = context;
        this.currentRoot = null;
    }
        resolveWebviewView(webviewView) {
        try {
            webviewView.webview.options = {
                enableScripts: true,
            };
            sidebarWebview = webviewView.webview;
            webviewView.webview.html = this.getHtml(webviewView.webview);
            webviewView.webview.postMessage({ type: 'chatHistory', conversationId, history: conversationHistory });
            output.appendLine('Sidebar webview rendered');
            webviewView.webview.onDidReceiveMessage(async (msg) => {
                try {
                    switch (msg.type) {
                        case 'selectRoot': {
                            const pick = await vscode.window.showOpenDialog({
                                canSelectFiles: false,
                                canSelectFolders: true,
                                canSelectMany: false,
                                openLabel: '选择作为分析根目录',
                            });
                            if (pick && pick[0]) {
                                this.currentRoot = pick[0].fsPath;
                                webviewView.webview.postMessage({ type: 'rootSelected', root: this.currentRoot });
                            }
                            break;
                        }
                        case 'buildGraph': {
                            const root = this.currentRoot || await ensureWorkspaceFolder();
                            await runBuildGraph(root);
                            break;
                        }
                        case 'impactGitDiff': {
                            const root = this.currentRoot || await ensureWorkspaceFolder();
                            const { range, direction } = msg.payload || {};
                            await runImpact({
                                gitRange: range || 'origin/main...HEAD',
                                depth: Infinity,
                                includeDynamic: true,
                                direction: direction || 'reverse',
                                root,
                                mermaid: true,
                                settings: {
                                    includeMmd: true,
                                    includeCode: true,
                                    codeMaxFiles: Infinity,
                                    codeMaxLines: Infinity,
                                }
                            });
                            break;
                        }
                        // case 'pickBgFiles': {
                        //     const picked = await vscode.window.showOpenDialog({
                        //         canSelectMany: true,
                        //         canSelectFiles: true,
                        //         canSelectFolders: false,
                        //         openLabel: '选择背景文件（小于 512KB）',
                        //     });
                        //     if (picked && picked.length) {
                        //         await readBgFiles(picked.map((u) => u.fsPath));
                        //         webviewView.webview.postMessage({
                        //             type: 'bgFilesUpdated',
                        //             files: bgFilesCache.map(f => ({ path: f.path, size: f.size, truncated: f.truncated })),
                        //         });
                        //     }
                        //     break;
                        // }
                        // case 'clearBgFiles': {
                        //     bgFilesCache = [];
                        //     webviewView.webview.postMessage({ type: 'bgFilesUpdated', files: [] });
                        //     break;
                        // }
                        case 'ai': {
                            await handleAI(msg.payload || {});
                            break;
                        }
                        case 'resetConversation': {
                            conversationId = null;
                            conversationHistory = [];
                            sidebarWebview?.postMessage({ type: 'chatHistory', conversationId, history: conversationHistory });
                            break;
                        }
                        default:
                            break;
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(err.message || String(err));
                    output.appendLine(`Error handling message ${msg.type}: ${err?.stack || err}`);
                }
            });
        } catch (err) {
            const msg = `resolveWebviewView error: ${err?.stack || err}`;
            output.appendLine(msg);
            console.error(msg);
            webviewView.webview.html = `<html><body>初始化失败：${err?.message || err}</body></html>`;
        }
    }

    getHtml(webview) {
        const cspSource = webview.cspSource;
        const nonce = this.getNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: sans-serif; padding: 8px; }
    h3 { margin: 0 0 8px; }
    button { width: 100%; margin: 4px 0; padding: 6px 8px;border-radius: 4px;background-color: white;color: black;border: 1px solid #ccc; }
    small { color: #888; }
    input, select { width: 100%; margin: 4px 0;border-radius: 4px;background-color: white;color: black;border: 1px solid #ccc; }
  </style>
</head>
<body>
  <div style="margin-bottom:6px;">
    <div id="rootLabel" style="font-size:12px;color:#666;">默认 src 目录</div>
    <button id="pickRoot">选择根目录</button>
  </div>

  <button id="build">构建依赖图</button>

  <div style="margin-top:8px;">
    <div><b>Git Diff 影响分析</b></div>
    <input id="gitRange" type="text" value="origin/main...HEAD" />
    <div style="display:flex;gap:8px;align-items:center;">
      <select id="dirGit">
        <option value="reverse" selected>反向箭头</option>
        <option value="forward">正向箭头</option>
      </select>
    </div>
    <button id="git">运行 Git Diff 分析</button>
  </div>

  <div style="margin-top:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <b>Agent 对话</b>
      <small id="convId" style="color:#888;">未建立会话</small>
    </div>
    <div id="chatHistory" style="margin-top:6px;padding:6px;border:1px solid #ddd;border-radius:4px;min-height:120px;max-height:220px;overflow-y:auto;font-size:12px;white-space:pre-wrap;color:white;background:transparent"></div>
    <textarea id="chatInput" rows="3" placeholder="输入问题..." style="width:100%;margin-top:6px;border-radius:4px;background:transparent;color:white;border:1px solid #ccc;"></textarea>
    <div style="display:flex;gap:8px;margin-top:6px;">
      <button id="ai">发送</button>
      <button id="resetChat">重置会话</button>
    </div>
    <div id="aiThinking" style="margin-top:6px;padding:6px;border:1px dashed #ccc;border-radius:4px;min-height:40px;font-size:12px;white-space:pre-wrap;color:white;background:transparent">等待中…</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rootLabel = document.getElementById('rootLabel');
    const aiBtn = document.getElementById('ai');
    const aiThinking = document.getElementById('aiThinking');
    const chatHistoryEl = document.getElementById('chatHistory');
    const chatInput = document.getElementById('chatInput');
    const resetChat = document.getElementById('resetChat');
    const convIdEl = document.getElementById('convId');
    const commonPayload = () => ({
      includeMmd: true,
      includeCode: true,
      includeDynamic: true,
    });
    const state = { conversationId: null, history: [] };
    const escape = (str = '') => String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const renderHistory = () => {
      convIdEl.textContent = state.conversationId || '未建立会话';
      if (!state.history.length) {
        chatHistoryEl.innerHTML = '<div style="color:#888;">暂无历史</div>';
        return;
      }
      chatHistoryEl.innerHTML = state.history.map((m) => {
        const role = m.role === 'assistant' ? 'Agent' : '我';
        return \`<div style="margin-bottom:6px;"><b>\${role}：</b>\${escape(m.text || '')}</div>\`;
      }).join('');
      chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
    };

    document.getElementById('pickRoot').onclick = () => vscode.postMessage({ type: 'selectRoot' });
    document.getElementById('build').onclick = () => vscode.postMessage({ type: 'buildGraph' });
    document.getElementById('git').onclick = () => {
      vscode.postMessage({
        type: 'impactGitDiff',
        payload: {
          range: document.getElementById('gitRange').value,
          direction: document.getElementById('dirGit').value,
          ...commonPayload(),
        }
      });
    };
    document.getElementById('ai').onclick = () => {
      const q = chatInput.value.trim();
      if (!q) {
        aiThinking.textContent = '请输入问题后再发送';
        return;
      }
      aiBtn.disabled = true;
      aiBtn.textContent = '发送中...';
      aiThinking.textContent = '模型思考中...';
      vscode.postMessage({ type: 'ai', payload: { ...commonPayload(), query: q } });
    };
    resetChat.onclick = () => {
      state.history = [];
      state.conversationId = null;
      renderHistory();
      aiThinking.textContent = '会话已重置';
      vscode.postMessage({ type: 'resetConversation' });
    };
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'rootSelected') {
        rootLabel.textContent = msg.root;
      }
      if (msg.type === 'aiRunning') {
        aiBtn.disabled = !!msg.running;
        aiBtn.textContent = msg.running ? '发送中...' : '发送';
        if (msg.running) aiThinking.textContent = '模型思考中...';
      }
      if (msg.type === 'aiFinal') {
        aiBtn.disabled = false;
        aiBtn.textContent = '发送';
        aiThinking.textContent = '思考已结束';
        chatInput.value = '';
      }
      if (msg.type === 'error') {
        aiBtn.disabled = false;
        aiBtn.textContent = '发送';
        aiThinking.textContent = '发生错误';
      }
      if (msg.type === 'aiThought') {
        aiThinking.textContent = msg.text || '';
      }
      if (msg.type === 'chatHistory') {
        state.history = msg.history || [];
        state.conversationId = msg.conversationId || null;
        renderHistory();
      }
    });
    renderHistory();
  </script>
</body>
</html>`;
    }

    getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}

