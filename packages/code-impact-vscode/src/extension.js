const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const output = vscode.window.createOutputChannel('Code Impact');
const MAX_BG_FILE_BYTES = 512 * 1024; // 512KB
let lastImpactCache = null; // { mmd, seeds, results, edges, direction, depth, includeDynamic, settings }
let bgFilesCache = []; // { path, size, content, truncated }

async function loadCore() {
    try {
        const core = await import('code-impact');
        return {
            buildGraph: core.buildGraph,
            saveGraph: core.saveGraph,
            loadGraph: core.loadGraph,
            traverseImpact: core.traverseImpact,
            getChangedFiles: core.getChangedFiles,
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
        if (norm.endsWith('impact.mmd')) return false;
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
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
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

async function runImpact({ files, gitRange, depth = 4, includeDynamic = true, mermaid = true, root, direction = 'reverse', settings = {} }) {
    const { loadGraph, traverseImpact, getChangedFiles } = await loadCore();
    const workspaceRoot = root || await ensureWorkspaceFolder();
    let targets = [];
    if (files && files.length) {
        targets = files.map((f) => path.isAbsolute(f) ? f : path.join(workspaceRoot, f));
    } else if (gitRange) {
        targets = getChangedFiles({ projectRoot: workspaceRoot, range: gitRange });
    }
    targets = filterTargets(targets);
    if (targets.length === 0) {
        vscode.window.showWarningMessage('未找到有效的变更文件（可能被忽略规则过滤）。');
        return;
    }

    const graph = await loadGraph(workspaceRoot);
    const { results, edges, seeds } = traverseImpact(graph, targets, {
        includeDynamic: true,
        depth: Number.isFinite(depth) ? depth : Infinity,
    });

    const mmd = toMermaid({ seeds, results, edges, direction });
    lastImpactCache = {
        mmd,
        seeds,
        results,
        edges,
        direction,
        depth,
        includeDynamic: true,
        root: workspaceRoot,
        settings: {
            includeMmd: true,
            includeCode: true,
            includeDynamic: true,
            codeMaxFiles: settings.codeMaxFiles || 5,
            codeMaxLines: settings.codeMaxLines || 200,
        }
    };
    if (mermaid) {
        await showMermaid(mmd);
    } else {
        const lines = results.map((r) => `${r.distance}\t${r.type}\t${r.id}`);
        await showMermaid(lines.join('\n'), 'impact.txt');
    }
}

async function handleAI(payload) {
    // 仅占位：将 payload 写入输出，便于后续对接实际 AI 接口
    try {
        output.appendLine(`AI payload summary: prdLen=${payload?.prd?.length || 0}, mmd=${payload?.includeMmd}, code=${payload?.includeCode}, bgFiles=${bgFilesCache.length}`);
    } catch (err) {
        output.appendLine(`handleAI error: ${err?.stack || err}`);
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
                            const { range, depth, direction } = msg.payload || {};
                            await runImpact({
                                gitRange: range || 'origin/main...HEAD',
                                depth: depth ? Number(depth) : 4,
                                includeDynamic: true,
                                direction: direction || 'reverse',
                                root,
                                mermaid: true,
                                settings: {
                                    includeMmd: true,
                                    includeCode: true,
                                    codeMaxFiles: 5,
                                    codeMaxLines: 200,
                                }
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
                            const { depth, direction } = msg.payload || {};
                            await runImpact({
                                files,
                                depth: depth ? Number(depth) : 4,
                                includeDynamic: true,
                                direction: direction || 'reverse',
                                root,
                                mermaid: true,
                                settings: {
                                    includeMmd: true,
                                    includeCode: true,
                                    codeMaxFiles: 5,
                                    codeMaxLines: 200,
                                }
                            });
                            break;
                        }
                        case 'pickBgFiles': {
                            const picked = await vscode.window.showOpenDialog({
                                canSelectMany: true,
                                canSelectFiles: true,
                                canSelectFolders: false,
                                openLabel: '选择背景文件（小于 512KB）',
                            });
                            if (picked && picked.length) {
                                await readBgFiles(picked.map((u) => u.fsPath));
                                webviewView.webview.postMessage({
                                    type: 'bgFilesUpdated',
                                    files: bgFilesCache.map(f => ({ path: f.path, size: f.size, truncated: f.truncated })),
                                });
                            }
                            break;
                        }
                        case 'clearBgFiles': {
                            bgFilesCache = [];
                            webviewView.webview.postMessage({ type: 'bgFilesUpdated', files: [] });
                            break;
                        }
                        case 'ai': {
                            const { prd } = msg.payload || {};
                            const payload = {
                                prd,
                                allowCode: true,
                                includeMmd: true,
                                includeCode: true,
                                codeMaxFiles: 5,
                                codeMaxLines: 200,
                                impact: lastImpactCache,
                                bgFiles: bgFilesCache,
                            };
                            await handleAI(payload);
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
    button { width: 100%; margin: 4px 0; padding: 6px 8px; }
    small { color: #888; }
    input, textarea, select, label { width: 100%; margin: 4px 0; }
    textarea { resize: vertical; }
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
      <label>深度 <input id="depthGit" type="number" value="4" style="width:60px;" /></label>
      <select id="dirGit">
        <option value="reverse" selected>反向箭头</option>
        <option value="forward">正向箭头</option>
      </select>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <label>最多文件 <input id="codeMaxFiles" type="number" value="5" style="width:50px;" /></label>
      <label>每文件行数 <input id="codeMaxLines" type="number" value="200" style="width:60px;" /></label>
    </div>
    <button id="git">运行 Git Diff 分析</button>
  </div>

  <div style="margin-top:8px;">
    <div><b>文件种子影响分析</b></div>
    <div style="display:flex;gap:8px;align-items:center;">
      <label>深度 <input id="depthFiles" type="number" value="4" style="width:60px;" /></label>
      <select id="dirFiles">
        <option value="reverse" selected>反向箭头</option>
        <option value="forward">正向箭头</option>
      </select>
    </div>
    <button id="files">选择文件并分析</button>
  </div>

  <div style="margin-top:8px;">
    <div><b>背景文件</b></div>
    <button id="pickBg">选择背景文件</button>
    <button id="clearBg">清空背景文件</button>
    <div id="bgList" style="font-size:12px;color:#aaa;margin-top:4px;">无</div>
  </div>

  <div style="margin-top:8px;">
    <div><b>AI 占位</b></div>
    <textarea id="prd" rows="3" placeholder="粘贴 PRD/需求"></textarea>
    <button id="ai">AI 分析（占位，不发送）</button>
  </div>

  <small>结果以 mermaid 打开，反向箭头表示从变更到受影响入口。</small>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rootLabel = document.getElementById('rootLabel');
    const bgList = document.getElementById('bgList');
    const state = { bgFiles: [] };
    const commonPayload = () => ({
      codeMaxFiles: Number(document.getElementById('codeMaxFiles').value || 5),
      codeMaxLines: Number(document.getElementById('codeMaxLines').value || 200),
      includeMmd: true,
      includeCode: true,
      includeDynamic: true,
    });

    const renderBg = () => {
      if (!state.bgFiles.length) { bgList.textContent = '无'; return; }
      bgList.innerHTML = state.bgFiles.map(f => {
        const sizeKb = Math.round(f.size / 1024);
        return f.path + ' (' + sizeKb + 'KB' + (f.truncated ? ',截断' : '') + ')';
      }).join('<br/>');
    };

    document.getElementById('pickRoot').onclick = () => vscode.postMessage({ type: 'selectRoot' });
    document.getElementById('build').onclick = () => vscode.postMessage({ type: 'buildGraph' });
    document.getElementById('git').onclick = () => {
      vscode.postMessage({
        type: 'impactGitDiff',
        payload: {
          range: document.getElementById('gitRange').value,
          depth: document.getElementById('depthGit').value,
          direction: document.getElementById('dirGit').value,
          ...commonPayload(),
        }
      });
    };
    document.getElementById('files').onclick = () => {
      vscode.postMessage({
        type: 'impactFiles',
        payload: {
          depth: document.getElementById('depthFiles').value,
          direction: document.getElementById('dirFiles').value,
          ...commonPayload(),
        }
      });
    };
    document.getElementById('pickBg').onclick = () => vscode.postMessage({ type: 'pickBgFiles' });
    document.getElementById('clearBg').onclick = () => vscode.postMessage({ type: 'clearBgFiles' });
    document.getElementById('ai').onclick = () => {
      vscode.postMessage({
        type: 'ai',
        payload: {
          prd: document.getElementById('prd').value,
          allowCode: true,
          ...commonPayload(),
        }
      });
    };
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'rootSelected') {
        rootLabel.textContent = msg.root;
      }
      if (msg.type === 'bgFilesUpdated') {
        state.bgFiles = msg.files || [];
        renderBg();
      }
    });
    renderBg();
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

