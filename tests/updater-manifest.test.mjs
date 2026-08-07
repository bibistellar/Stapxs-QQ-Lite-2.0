import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildUpdaterManifest } from '../scripts/generate-updater-json.mjs'

test('builds a complete Tauri updater manifest', async() => {
    const directory = await mkdtemp(join(tmpdir(), 'stapxs-updater-'))
    const assets = [
        'Stapxs.QQ.Lite_3.4.7_x64-setup.exe',
        'Stapxs.QQ.Lite_3.4.7_amd64.AppImage',
        'Stapxs.QQ.Lite_3.4.7_aarch64.AppImage',
        'Stapxs.QQ.Lite_3.4.7_x64.app.tar.gz',
        'Stapxs.QQ.Lite_3.4.7_aarch64.app.tar.gz',
    ]
    await Promise.all(assets.flatMap((name) => [
        writeFile(join(directory, name), ''),
        writeFile(join(directory, `${name}.sig`), `signature:${name}`),
    ]))

    const manifest = await buildUpdaterManifest({
        assetsDirectory: directory,
        repository: 'bibistellar/Stapxs-QQ-Lite-2.0',
        version: '3.4.7',
        notes: '测试更新',
        pubDate: '2026-08-07T00:00:00.000Z',
    })

    assert.equal(manifest.version, '3.4.7')
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
        'darwin-aarch64',
        'darwin-x86_64',
        'linux-aarch64',
        'linux-x86_64',
        'windows-x86_64',
    ])
    assert.match(manifest.platforms['windows-x86_64'].url, /x64-setup\.exe$/)
})

test('rejects a partial updater release', async() => {
    const directory = await mkdtemp(join(tmpdir(), 'stapxs-updater-'))
    await assert.rejects(
        buildUpdaterManifest({
            assetsDirectory: directory,
            repository: 'owner/repo',
            version: '1.0.0',
            notes: '',
            pubDate: '2026-08-07T00:00:00.000Z',
        }),
        /缺少更新平台产物/,
    )
})
