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

// Fetch merkle path
const pathRes = await fetch('https://backend.zkllmapi.com/merkle-path/' + commitment.toString());
const pathData = await pathRes.json();
console.log('Merkle path:', JSON.stringify(pathData).slice(0,100));

await bb.destroy();
