#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import path from 'path';
import { buildGraph, saveGraph, loadGraph } from './graph.js';
import { traverseImpact } from './impact.js';
import { getChangedFiles } from './git.js';

const program = new Command();
program.name('code-impact').description('前端依赖图与影响分析 CLI');

function parseList(val) {
    return val.split(',').map((v) => v.trim()).filter(Boolean);
}

function toMermaid({ seeds, results, edges }) {
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
        if (!idMap.has(id)) return;
        const label = String(id).replace(/"/g, '\\"');
        lines.push(`  ${idMap.get(id)}["${label}"]`);
    });
    (edges || []).forEach((e) => {
        if (!e?.from || !e?.to) return;
        const from = idMap.get(e.from);
        const to = idMap.get(e.to);
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

function printImpact({ seeds, results, edges }, format = 'table') {
    if (format === 'json') {
        console.log(JSON.stringify({ seeds, results, edges }, null, 2));
        return;
    }
    if (format === 'mermaid') {
        console.log(toMermaid({ seeds, results, edges }));
        return;
    }
    const table = new Table({
        head: ['距离', '类型', '路径/包'],
        colWidths: [8, 10, 80],
        wordWrap: true,
    });
    results.forEach((r) => {
        const typeColor =
            r.type === 'pkg' ? chalk.cyan : r.type === 'style' ? chalk.magenta : r.type === 'asset' ? chalk.yellow : chalk.green;
        table.push([r.distance, typeColor(r.type), r.id]);
    });
    console.log(table.toString());
}

program
    .command('build-graph')
    .description('扫描源码并生成依赖图')
    .option('--root <paths>', '源码根目录，逗号分隔，多包可用', parseList)
    .option('--webpack-config <path>', 'webpack 配置文件路径，默认尝试 webpack.config.*')
    .action(async (opts) => {
        const projectRoot = process.cwd();
        try {
            const graph = await buildGraph({
                projectRoot,
                roots: opts.root,
                webpackConfig: opts.webpackConfig,
            });
            const out = await saveGraph(graph, projectRoot);
            console.log(chalk.green(`依赖图已生成: ${out}`));
            if (graph.errors?.length) {
                console.log(chalk.yellow(`解析出现 ${graph.errors.length} 个警告，详情见 graph.json errors 字段`));
            }
        } catch (err) {
            console.error(chalk.red(`构建失败: ${err.message}`));
            process.exitCode = 1;
        }
    });

function filterTargets(list = []) {
    return list.filter((p) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.includes('/.code-impact/')) return false;
        if (norm.endsWith('/impact.mmd') || norm.endsWith('\\impact.mmd') || norm.endsWith('impact.mmd')) return false;
        return true;
    });
}

program
    .command('impact')
    .description('基于依赖图进行影响分析')
    .option('--files <paths>', '逗号分隔的文件列表', parseList)
    .option('--git-diff [range]', '使用 git diff 范围（默认 HEAD~1..HEAD）', 'HEAD~1..HEAD')
    .option('--depth <n>', '向上追踪深度', (v) => Number(v), Infinity)
    .option('--format <fmt>', '输出格式 table|json|mermaid', 'table')
    .option('--include-dynamic', '包含动态 import 影响', false)
    .action(async (opts) => {
        const projectRoot = process.cwd();
        let targets = [];
        if (opts.files && opts.files.length) {
            targets = opts.files.map((p) => path.resolve(projectRoot, p));
        } else if (opts.gitDiff) {
            targets = getChangedFiles({ projectRoot, range: opts.gitDiff });
            if (targets.length === 0) {
                console.log(chalk.yellow('git diff 未找到变更文件'));
                return;
            }
            const msg = `使用 git diff 范围 ${opts.gitDiff}，变更文件 ${targets.length} 个`;
            // 避免污染 mermaid/json 输出，进度信息走 stderr
            if (opts.format === 'table') {
                console.log(chalk.cyan(msg));
            } else {
                console.error(chalk.cyan(msg));
            }
        } else {
            console.error(chalk.red('请提供 --files 或 --git-diff'));
            process.exitCode = 1;
            return;
        }

        targets = filterTargets(targets);
        if (targets.length === 0) {
            console.error(chalk.yellow('过滤后无有效变更文件（已忽略 .code-impact 与 impact.mmd）'));
            return;
        }

        try {
            const graph = await loadGraph(projectRoot);
            const { results, edges } = traverseImpact(graph, targets, {
                includeDynamic: !!opts.includeDynamic,
                depth: Number.isFinite(opts.depth) ? opts.depth : Infinity,
            });
            printImpact({ seeds: targets, results, edges }, opts.format);
        } catch (err) {
            console.error(chalk.red(`分析失败: ${err.message}`));
            process.exitCode = 1;
        }
    });

program.parseAsync().catch((err) => {
    console.error(chalk.red(err.message));
    process.exit(1);
});

