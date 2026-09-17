const fs = require('node:fs/promises');
const path = require('node:path');
const { PNG } = require('../../../node_modules/pngjs');

// Deterministic original fixture artwork/tone. Output is ordinary PNG and PCM WAV, not an importer format.
async function makeFixtureAssets(directory) {
    await fs.mkdir(directory, { recursive: true });
    const image = new PNG({ width: 32, height: 32 });
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const offset = (y * 32 + x) * 4;
        const border = x < 2 || y < 2 || x >= 30 || y >= 30;
        image.data.set(border ? [255, 255, 255, 255] : [40, 220, 160, 255], offset);
    }
    await fs.writeFile(path.join(directory, 'tile.png'), PNG.sync.write(image), { flag: 'wx' });
    const samples = 4410;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    for (let index = 0; index < samples; index++) {
        wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 660 / 44100) * 8000 * (1 - index / samples)), 44 + index * 2);
    }
    await fs.writeFile(path.join(directory, 'click.wav'), wav, { flag: 'wx' });
}

module.exports = { makeFixtureAssets };
