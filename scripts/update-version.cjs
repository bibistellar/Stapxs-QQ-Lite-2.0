/* eslint-env node */
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rootPackagePath = path.join(rootDir, 'package.json');
const tauriCargoPath = path.join(rootDir, 'src/tauri/Cargo.toml');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function updateTauriVersion(appVersion) {
    const cargoContent = fs.readFileSync(tauriCargoPath, 'utf8');
    const nextContent = cargoContent.replace(
        /(\[package\][\s\S]*?^version = ")([^"]+)(")/m,
        `$1${appVersion}$3`
    );

    if (nextContent === cargoContent) {
        return false;
    }

    fs.writeFileSync(tauriCargoPath, nextContent, 'utf8');
    return true;
}

function main() {
    const appVersion = readJson(rootPackagePath).version;

    console.log(`Syncing project version to ${appVersion}`);

    const tauriUpdated = updateTauriVersion(appVersion);
    console.log(
        tauriUpdated? `Updated src/tauri/Cargo.toml -> ${appVersion}`: 'src/tauri/Cargo.toml already up to date'
    );
}

main();
