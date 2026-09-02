import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(root, '..', 'SOURCE');
const read = (file) => fs.readFileSync(path.join(sourceDir, file), 'utf8');

// An earlier version stripped `//` comments and globally collapsed
// whitespace, which corrupted a comment into swallowing live code (the
// comment's terminating newline got collapsed away along with everything
// else). This transform only trims each line's leading/trailing whitespace
// and drops blank lines — it never merges two lines into one and never
// touches mid-line content, so it cannot affect where a `//` comment (or
// a `//` inside any string) starts or ends. Comments and code that were on
// separate lines stay on separate lines.
const compactJs = (src) => src.split('\n')
  .map((line) => line.replace(/^\s+/, '').replace(/\s+$/, ''))
  .filter((line) => line.length > 0)
  .join('\n');

const html = read('index.html')
  .replace('<script src="src/game-core.js"></script>', `<script>${compactJs(read('src/game-core.js'))}</script>`)
  .replace('<script src="src/wavedash-adapter.js"></script>', `<script>${compactJs(read('src/wavedash-adapter.js'))}</script>`)
  .replace('<script src="src/game.js"></script>', `<script>${compactJs(read('src/game.js'))}</script>`)
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();

const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);

// Minimal, deterministic, dependency-free single-entry ZIP writer using
// only Node's built-in zlib (deflate). This replaces shelling out to an
// external `zip` CLI (not always on PATH) or PowerShell's Compress-Archive
// (embeds real timestamps, so the same source can produce different ZIP
// bytes on different runs/environments). A fixed DOS date/time makes the
// archive byte-identical across repeated builds of unchanged source.
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function makeZip(entryName, data) {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01, the minimum valid DOS date; fixed so builds are reproducible

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const localEntry = Buffer.concat([local, nameBuf, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralEntry = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const zipPath = path.join(artifacts, 'rainbow-refrain-mvp.zip');
const zipBuffer = makeZip('index.html', Buffer.from(html, 'utf8'));
fs.writeFileSync(zipPath, zipBuffer);

const bytes = zipBuffer.length;
fs.writeFileSync(path.join(artifacts, 'size.txt'), `${bytes}\n`);
console.log(JSON.stringify({ dist: path.relative(root, dist), zip: path.relative(root, zipPath), bytes }, null, 2));
