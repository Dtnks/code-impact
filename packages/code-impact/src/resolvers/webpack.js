import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const DEFAULT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.less'];

const CANDIDATES = ['webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs'];

async function importConfig(filePath) {
    const url = pathToFileURL(filePath).href;
    const mod = await import(url);
    return mod?.default ?? mod;
}

export async function loadWebpackResolve({ projectRoot, webpackConfig }) {
    const base = webpackConfig
        ? path.resolve(projectRoot, webpackConfig)
        : CANDIDATES.map((c) => path.join(projectRoot, c)).find((p) => fs.existsSync(p));

    if (!base || !fs.existsSync(base)) {
        return { alias: {}, extensions: DEFAULT_EXTS };
    }

    try {
        const config = await importConfig(base);
        const resolve = Array.isArray(config)
            ? config.find((c) => c?.resolve)?.resolve
            : config?.resolve;
        return {
            alias: resolve?.alias ?? {},
            extensions: resolve?.extensions ?? DEFAULT_EXTS,
        };
    } catch {
        return { alias: {}, extensions: DEFAULT_EXTS };
    }
}

