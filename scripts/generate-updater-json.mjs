import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PLATFORM_ASSETS = {
    'windows-x86_64': /_x64-setup\.exe$/i,
    'linux-x86_64': /_amd64\.AppImage$/,
    'linux-aarch64': /_aarch64\.AppImage$/,
    'darwin-x86_64': /_x64\.app\.tar\.gz$/,
    'darwin-aarch64': /_aarch64\.app\.tar\.gz$/,
}

async function listFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(entries.map((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? listFiles(path) : [path]
    }))
    return nested.flat()
}

export async function buildUpdaterManifest({ assetsDirectory, repository, version, notes, pubDate }) {
    const files = await listFiles(assetsDirectory)
    const platforms = {}

    for (const [platform, pattern] of Object.entries(PLATFORM_ASSETS)) {
        const asset = files.find((file) => pattern.test(basename(file)))
        if (!asset) continue

        const signatureFile = files.find((file) => file === `${asset}.sig`)
        if (!signatureFile) {
            throw new Error(`缺少 ${basename(asset)} 对应的签名文件`)
        }

        const assetName = basename(asset)
        platforms[platform] = {
            signature: (await readFile(signatureFile, 'utf8')).trim(),
            url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(assetName)}`,
        }
    }

    const missing = Object.keys(PLATFORM_ASSETS).filter((platform) => !platforms[platform])
    if (missing.length > 0) {
        throw new Error(`缺少更新平台产物：${missing.join(', ')}`)
    }

    return {
        version,
        notes,
        pub_date: pubDate,
        platforms,
    }
}

async function main() {
    const [assetsDirectory, repository, version, notes = '版本更新', pubDate = new Date().toISOString()] = process.argv.slice(2)
    if (!assetsDirectory || !repository || !version) {
        throw new Error('用法：node scripts/generate-updater-json.mjs <产物目录> <仓库> <版本> [说明] [发布时间]')
    }

    const manifest = await buildUpdaterManifest({ assetsDirectory, repository, version, notes, pubDate })
    const output = join(assetsDirectory, 'latest.json')
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`已生成 ${output}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
    })
}
