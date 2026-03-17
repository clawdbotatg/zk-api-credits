import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');

const { Barretenberg, Fr, UltraHonkBackend } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');
const { Noir } = require('/Users/austingriffith/clawd/zk-api-credits/packages/nextjs/node_modules/@noir-lang/noir_js/lib/index.cjs');

console.log('Initializing Barretenberg...');
const bb = await Barretenberg.new({ threads: 4 });

const nullifier = 217573075678466085543686199875837717223827206919167382298658268180168181192n;
const secret = 416004215156021411935117945062630819180045795013474089374495959237613425848n;

// Use bb's native poseidon2Hash — matches Noir's Poseidon2::hash exactly
const nullifierHash = await bb.poseidon2Hash([new Fr(nullifier)]);
const commitment = await bb.poseidon2Hash([new Fr(nullifier), new Fr(secret)]);

console.log('nullifierHash:', nullifierHash.toString());
console.log('commitment:', commitment.toString());

// Fetch full tree — path computed locally so server never sees which commitment we're using
const _treeRes = await fetch('https://backend.zkllmapi.com/tree');
const _treeData = await _treeRes.json();
const _leafIdx = _treeData.leaves.findIndex(l => l === commitment.toString());
if (_leafIdx === -1) throw new Error('Commitment not found in tree');
const _sib = [], _ind = [];
let _ci = _leafIdx;
for (let i = 0; i < 16; i++) {
  _sib.push(i < _treeData.depth ? _treeData.levels[i][_ci ^ 1] : _treeData.zeros[i]);
  _ind.push((_leafIdx >> i) & 1);
  _ci >>= 1;
}
const pathData = { leafIndex: _leafIdx, siblings: _sib, indices: _ind, root: _treeData.root, depth: _treeData.depth };
console.log('Merkle path:', JSON.stringify(pathData).slice(0,100));

await bb.destroy();
