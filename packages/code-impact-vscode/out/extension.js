var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
const vscode = require('vscode');
const path = require('path');
const output = vscode.window.createOutputChannel('Code Impact');
async function loadCore() {
    try {
        const core = await Promise.resolve().then(() => __importStar(require('code-impact')));
        return {
            buildGraph: core.buildGraph,
            saveGraph: core.saveGraph,
            loadGraph: core.loadGraph,
            traverseImpact: core.traverseImpact,
            getChangedFiles: core.getChangedFiles,
        };
    }
    catch (err) {
        output.appendLine(`loadCore failed: ${err?.stack || err}`);
        throw err;
    }
}
function filterTargets(list = []) {
    return list.filter((p) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.includes('/.code-impact/'))
            return false;
        if (norm.endsWith('impact.mmd'))
            return false;
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
async function runBuildGraph(root) {
    const { buildGraph, saveGraph } = await loadCore();
    const graph = await buildGraph({ projectRoot: root, roots: ['src'] });
    const out = await saveGraph(graph, root);
    vscode.window.showInformationMessage(`依赖图已生成: ${out}`);
}
function toMermaid({ seeds, results, edges, direction = 'reverse' }) {
    const ids = new Set();
    [...(seeds || []), ...(results || []).map((r) => r.id)].forEach((id) => {
        if (id)
            ids.add(id);
    });
    (edges || []).forEach((e) => {
        if (e?.from)
            ids.add(e.from);
        if (e?.to)
            ids.add(e.to);
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
        if (!e?.from || !e?.to)
            return;
        const forwardFrom = direction === 'reverse' ? e.to : e.from;
        const forwardTo = direction === 'reverse' ? e.from : e.to;
        const from = idMap.get(forwardFrom);
        const to = idMap.get(forwardTo);
        if (!from || !to)
            return;
        const dyn = e.dynamic ? '|dynamic|' : '';
        lines.push(`  ${from} -->${dyn} ${to}`);
    });
    const seedIds = (seeds || []).map((s) => idMap.get(s)).filter(Boolean);
    const impactIds = (results || []).map((r) => idMap.get(r.id)).filter(Boolean);
    lines.push('  classDef seed fill:#ffd166,stroke:#d49b00,stroke-width:1.5px;');
    lines.push('  classDef impact fill:#ef476f,color:#fff;');
    if (seedIds.length)
        lines.push(`  class ${seedIds.join(',')} seed;`);
    if (impactIds.length)
        lines.push(`  class ${impactIds.join(',')} impact;`);
    return lines.join('\n');
}
async function showMermaid(content, title = 'impact.mmd') {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
    showInfo(`${title} 已生成（可用 Mermaid 预览插件查看）`);
}
async function runImpact({ files, gitRange, depth = 4, includeDynamic = true, mermaid = true, root, direction = 'reverse' }) {
    const { loadGraph, traverseImpact, getChangedFiles } = await loadCore();
    const workspaceRoot = root || await ensureWorkspaceFolder();
    let targets = [];
    if (files && files.length) {
        targets = files.map((f) => path.isAbsolute(f) ? f : path.join(workspaceRoot, f));
    }
    else if (gitRange) {
        targets = getChangedFiles({ projectRoot: workspaceRoot, range: gitRange });
    }
    targets = filterTargets(targets);
    if (targets.length === 0) {
        vscode.window.showWarningMessage('未找到有效的变更文件（可能被忽略规则过滤）。');
        return;
    }
    const graph = await loadGraph(workspaceRoot);
    const { results, edges, seeds } = traverseImpact(graph, targets, {
        includeDynamic,
        depth: Number.isFinite(depth) ? depth : Infinity,
    });
    if (mermaid) {
        const mmd = toMermaid({ seeds, results, edges, direction });
        await showMermaid(mmd);
    }
    else {
        const lines = results.map((r) => `${r.distance}\t${r.type}\t${r.id}`);
        await showMermaid(lines.join('\n'), 'impact.txt');
    }
}
async function handleAI(prd, allowCode) {
    if (!allowCode) {
        vscode.window.showInformationMessage('已取消 AI 分析（接口占位，未调用）。');
        return;
    }
    vscode.window.showInformationMessage(`AI 接口占位：PRD 长度 ${prd?.length || 0}。后续可接入具体模型调用。`);
}
function activate(context) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('codeImpact.sidebar', new CodeImpactSidebarProvider(context), {
        webviewOptions: { retainContextWhenHidden: true },
    }));
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
            webviewView.webview.html = this.getHtml(webviewView.webview);
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
                            const { range, depth, direction, includeDynamic } = msg.payload || {};
                            await runImpact({
                                gitRange: range || 'origin/main...HEAD',
                                depth: depth ? Number(depth) : 4,
                                includeDynamic: !!includeDynamic,
                                direction: direction || 'reverse',
                                root,
                                mermaid: true,
                            });
                            break;
                        }
                        case 'impactFiles': {
                            const root = this.currentRoot || await ensureWorkspaceFolder();
                            const selection = await vscode.window.showOpenDialog({
                                canSelectMany: true,
                                canSelectFiles: true,
                                canSelectFolders: false,
                                openLabel: '选择作为种子文件',
                            });
                            const files = selection?.map((u) => u.fsPath) || [];
                            if (!files.length) {
                                vscode.window.showWarningMessage('未选择文件。');
                                break;
                            }
                            const { depth, direction, includeDynamic } = msg.payload || {};
                            await runImpact({
                                files,
                                depth: depth ? Number(depth) : 4,
                                includeDynamic: !!includeDynamic,
                                direction: direction || 'reverse',
                                root,
                                mermaid: true,
                            });
                            break;
                        }
                        case 'ai': {
                            const { prd, allowCode } = msg.payload || {};
                            await handleAI(prd, !!allowCode);
                            break;
                        }
                        default:
                            break;
                    }
                }
                catch (err) {
                    vscode.window.showErrorMessage(err.message || String(err));
                    output.appendLine(`Error handling message ${msg.type}: ${err?.stack || err}`);
                }
            });
        }
        catch (err) {
            output.appendLine(`resolveWebviewView error: ${err?.stack || err}`);
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
    button { width: 100%; margin: 4px 0; padding: 6px 8px; }
    small { color: #888; }
    input, textarea, select, label { width: 100%; margin: 4px 0; }
    textarea { resize: vertical; }
  </style>
</head>
<body>
  <h3>Code Impact</h3>
  <div style="margin-bottom:6px;">
    <div><b>分析根目录</b></div>
    <div id="rootLabel" style="font-size:12px;color:#666;">(默认工作区)</div>
    <button id="pickRoot">选择根目录</button>
  </div>

  <button id="build">构建依赖图 (src)</button>

  <div style="margin-top:8px;">
    <div><b>Git Diff 影响分析</b></div>
    <input id="gitRange" type="text" value="origin/main...HEAD" />
    <label><input type="checkbox" id="dynGit" checked /> 包含动态 import</label>
    <label>深度 <input id="depthGit" type="number" value="4" style="width:60px;" /></label>
    <select id="dirGit">
      <option value="reverse" selected>反向箭头</option>
      <option value="forward">正向箭头</option>
    </select>
    <button id="git">运行 Git Diff 分析</button>
  </div>

  <div style="margin-top:8px;">
    <div><b>文件种子影响分析</b></div>
    <label><input type="checkbox" id="dynFiles" checked /> 包含动态 import</label>
    <label>深度 <input id="depthFiles" type="number" value="4" style="width:60px;" /></label>
    <select id="dirFiles">
      <option value="reverse" selected>反向箭头</option>
      <option value="forward">正向箭头</option>
    </select>
    <button id="files">选择文件并分析</button>
  </div>

  <div style="margin-top:8px;">
    <div><b>AI 占位</b></div>
    <textarea id="prd" rows="3" placeholder="粘贴 PRD/需求"></textarea>
    <label><input type="checkbox" id="allowCode" checked /> 允许发送代码片段</label>
    <button id="ai">AI 分析（占位，不发送）</button>
  </div>

  <small>结果以 mermaid 打开，反向箭头表示从变更到受影响入口。</small>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rootLabel = document.getElementById('rootLabel');
    document.getElementById('pickRoot').onclick = () => vscode.postMessage({ type: 'selectRoot' });
    document.getElementById('build').onclick = () => vscode.postMessage({ type: 'buildGraph' });
    document.getElementById('git').onclick = () => {
      vscode.postMessage({
        type: 'impactGitDiff',
        payload: {
          range: document.getElementById('gitRange').value,
          depth: document.getElementById('depthGit').value,
          direction: document.getElementById('dirGit').value,
          includeDynamic: document.getElementById('dynGit').checked,
        }
      });
    };
    document.getElementById('files').onclick = () => {
      vscode.postMessage({
        type: 'impactFiles',
        payload: {
          depth: document.getElementById('depthFiles').value,
          direction: document.getElementById('dirFiles').value,
          includeDynamic: document.getElementById('dynFiles').checked,
        }
      });
    };
    document.getElementById('ai').onclick = () => {
      vscode.postMessage({
        type: 'ai',
        payload: {
          prd: document.getElementById('prd').value,
          allowCode: document.getElementById('allowCode').checked,
        }
      });
    };
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'rootSelected') {
        rootLabel.textContent = msg.root;
      }
    });
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
