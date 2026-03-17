/**
 * Full E2E test: stake → register → prove → call LLM
 * Uses Barretenberg Poseidon2 (matches Noir circuit exactly)
 */
import fs from 'fs';
import { createRequire } from 'module';
import { ethers } from '/Users/austingriffith/clawd/zk-api-credits/packages/hardhat/node_modules/ethers/lib.esm/index.js';
const require = createRequire(import.meta.url);

process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');

const { Barretenberg, Fr, UltraHonkBackend } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');
const { Noir } = require('/Users/austingriffith/clawd/zk-api-credits/packages/nextjs/node_modules/@noir-lang/noir_js/lib/index.cjs');

const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error('TEST_PRIVATE_KEY not set — copy test-e2e.env.example to test-e2e.env and fill it in'); process.exit(1); }
const CLAWD = '0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07';
const API_CREDITS = '0x234d536e1623546F394707D6dB700f9c8CD29476';
const BACKEND_URL = 'https://backend.zkllmapi.com';

console.log('=== ZK API Credits E2E Test ===\n');

// Setup
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
if (!ALCHEMY_KEY) { console.error('ALCHEMY_API_KEY not set — copy test-e2e.env.example to test-e2e.env and fill it in'); process.exit(1); }
const provider = new ethers.JsonRpcProvider(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log('Wallet:', wallet.address);

const clawdContract = new ethers.Contract(CLAWD, [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
], wallet);

const apiContract = new ethers.Contract(API_CREDITS, [
  'function stake(uint256)',
  'function register(uint256)',
  'function stakedBalance(address) view returns (uint256)',
  'function getTreeData() view returns (uint256,uint256,uint256)'
], wallet);

// Init Barretenberg (for Poseidon2 that matches Noir)
console.log('\n[1] Initializing Barretenberg Poseidon2...');
const bb = await Barretenberg.new({ threads: 4 });

// Generate secrets using crypto
const { randomBytes } = await import('crypto');
const nullifier = BigInt('0x' + randomBytes(31).toString('hex'));
const secret = BigInt('0x' + randomBytes(31).toString('hex'));

// Compute using Barretenberg Poseidon2 (matches Noir circuit exactly)
const nullifierHashFr = await bb.poseidon2Hash([new Fr(nullifier)]);
const commitmentFr = await bb.poseidon2Hash([new Fr(nullifier), new Fr(secret)]);
const frToBigInt = (fr) => BigInt('0x' + Buffer.from(fr.value).toString('hex'));
const nullifierHash = frToBigInt(nullifierHashFr);
const commitment = frToBigInt(commitmentFr);

console.log('   nullifier:', nullifier.toString().slice(0,20)+'...');
console.log('   nullifierHash:', nullifierHash.toString().slice(0,20)+'...');
console.log('   commitment:', commitment.toString().slice(0,20)+'...');

// Check balances
const bal = await clawdContract.balanceOf(wallet.address);
const staked = await apiContract.stakedBalance(wallet.address);
console.log('\n[2] Balances:');
console.log('   CLAWD:', ethers.formatEther(bal));
console.log('   Staked:', ethers.formatEther(staked));

if (bal < ethers.parseEther('1000') && staked < ethers.parseEther('1000')) {
  console.log('ERROR: Need at least 1000 CLAWD');
  process.exit(1);
}

// Stake if needed
if (staked < ethers.parseEther('1000')) {
  console.log('\n[3] Approving CLAWD...');
  const allowance = await clawdContract.allowance(wallet.address, API_CREDITS);
  if (allowance < ethers.parseEther('1000')) {
    const tx = await clawdContract.approve(API_CREDITS, ethers.parseEther('1000'));
    await tx.wait();
    console.log('   Approved:', tx.hash);
  } else {
    console.log('   Already approved');
  }

  console.log('[3] Staking 1000 CLAWD...');
  const stakeTx = await apiContract.stake(ethers.parseEther('1000'));
  await stakeTx.wait();
  console.log('   Staked:', stakeTx.hash);
} else {
  console.log('\n[3] Already have staked balance, skipping stake');
}

// Register
console.log('\n[4] Registering commitment...');
const regTx = await apiContract.register(commitment);
await regTx.wait();
console.log('   Registered:', regTx.hash);

const [size, depth, root] = await apiContract.getTreeData();
console.log('   Tree size:', size.toString(), '| Root:', root.toString().slice(0,20)+'...');

// Get merkle path
console.log('\n[5] Fetching merkle path...');
// Fetch full tree — path computed locally so server never sees which commitment we're using
const _treeRes = await fetch(`${BACKEND_URL}/tree`);
const _treeData = await _treeRes.json();
if (_treeData.error) { console.log('ERROR fetching tree:', _treeData.error); process.exit(1); }
const leafIndex = _treeData.leaves.findIndex(l => l === commitment.toString());
if (leafIndex === -1) { console.log('ERROR: commitment not found in tree'); process.exit(1); }
const siblings = [], indices = [];
let _ci = leafIndex;
for (let i = 0; i < 16; i++) {
  siblings.push(i < _treeData.depth ? _treeData.levels[i][_ci ^ 1] : _treeData.zeros[i]);
  indices.push((leafIndex >> i) & 1);
  _ci >>= 1;
}
console.log('   leafIndex:', leafIndex, '| siblings[0]:', siblings[0].slice(0,20)+'...');

// Generate ZK proof
console.log('\n[6] Generating ZK proof (takes ~60s)...');
const circuit = JSON.parse(fs.readFileSync('/Users/austingriffith/clawd/zk-api-credits/packages/circuits/target/circuits.json', 'utf8'));
const backend = new UltraHonkBackend(circuit.bytecode);
const noir = new Noir(circuit);

const { witness } = await noir.execute({
  nullifier_hash: nullifierHash.toString(),
  root: root.toString(),
  depth: 16,
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  indices: indices.map(String),
  siblings: siblings.map(String),
});
console.log('   Witness generated');

const { proof } = await backend.generateProof(witness);
console.log('   Proof generated! bytes:', proof.length);

// Call the LLM API
const proofHex = '0x' + Buffer.from(proof).toString('hex');
const nullifierHashHex = '0x' + nullifierHash.toString(16).padStart(64,'0');
const rootHex = '0x' + root.toString(16).padStart(64,'0');

console.log('\n[7] Calling zkllmapi.com...');
const res = await fetch(`${BACKEND_URL}/v1/chat`, {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    proof: proofHex,
    nullifier_hash: nullifierHashHex,
    root: rootHex,
    depth: 16,
    messages: [{role:'user', content:'gm! Say hello in one sentence.'}],
    model: 'llama-3.3-70b'
  })
});

const data = await res.json();
console.log('   Status:', res.status);
console.log('\n=== LLM REPLY ===');
console.log(data?.choices?.[0]?.message?.content || JSON.stringify(data));

await bb.destroy();
