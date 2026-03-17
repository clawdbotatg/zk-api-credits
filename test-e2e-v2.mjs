/**
 * Full E2E test using local API server (port 3002)
 * Uses Barretenberg Poseidon2 (matches Noir circuit exactly)
 */
import fs from 'fs';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
const require = createRequire(import.meta.url);

process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');

const { Barretenberg, Fr, UltraHonkBackend } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');
const { Noir } = require('/Users/austingriffith/clawd/zk-api-credits/packages/nextjs/node_modules/@noir-lang/noir_js/lib/index.cjs');
const { ethers } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/hardhat/node_modules/ethers/lib.esm/index.js');

const PRIVATE_KEY = '0xc5dc5e3bd1ab3b694f8a821c027e269b50442e9c61901948a6712e3d4d0f2b43';
const CLAWD = '0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07';
const API_CREDITS = '0x1b2174E2E6E438B9d8be68A65Fc5f001d06fc4F6';
const LOCAL_SERVER = 'http://localhost:3002';

const frToBigInt = (fr) => BigInt('0x' + Buffer.from(fr.value).toString('hex'));

console.log('=== ZK API Credits E2E Test v2 ===\n');

// Init
const provider = new ethers.JsonRpcProvider('https://base-mainnet.g.alchemy.com/v2/8GVG8WjDs-sGFRr6Rm839');
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

// Init Barretenberg
console.log('[1] Init Barretenberg...');
const bb = await Barretenberg.new({ threads: 4 });

// Generate fresh secrets
const nullifier = BigInt('0x' + randomBytes(31).toString('hex'));
const secret = BigInt('0x' + randomBytes(31).toString('hex'));

// Compute with real Poseidon2
const nullifierHashFr = await bb.poseidon2Hash([new Fr(nullifier)]);
const commitmentFr = await bb.poseidon2Hash([new Fr(nullifier), new Fr(secret)]);
const nullifierHash = frToBigInt(nullifierHashFr);
const commitment = frToBigInt(commitmentFr);

console.log('   nullifier:', nullifier.toString().slice(0,20)+'...');
console.log('   commitment:', commitment.toString().slice(0,20)+'...');

// Check balances
const bal = await clawdContract.balanceOf(wallet.address);
const staked = await apiContract.stakedBalance(wallet.address);
console.log('\n[2] Balances: CLAWD:', ethers.formatEther(bal), '| Staked:', ethers.formatEther(staked));

// Stake if needed
if (staked < ethers.parseEther('1000')) {
  const allowance = await clawdContract.allowance(wallet.address, API_CREDITS);
  if (allowance < ethers.parseEther('1000')) {
    console.log('[3] Approving...');
    await (await clawdContract.approve(API_CREDITS, ethers.parseEther('1000'))).wait();
  }
  console.log('[3] Staking 1000 CLAWD...');
  await (await apiContract.stake(ethers.parseEther('1000'))).wait();
  console.log('   Staked!');
} else {
  console.log('[3] Already staked, skipping');
}

// Register commitment
console.log('\n[4] Registering commitment...');
const regTx = await apiContract.register(commitment);
await regTx.wait();
console.log('   Registered:', regTx.hash);

const [size, , root] = await apiContract.getTreeData();
console.log('   Tree size:', size.toString(), '| Root:', root.toString().slice(0,20)+'...');

// Get merkle path from local server
console.log('\n[5] Fetching merkle path...');
// Fetch full tree — path computed locally so server never sees which commitment we're using
const _treeRes = await fetch(`${LOCAL_SERVER}/tree`);
const _treeData = await _treeRes.json();
if (_treeData.error) throw new Error('Tree error: ' + _treeData.error);
const leafIndex = _treeData.leaves.findIndex(l => l === commitment.toString());
if (leafIndex === -1) throw new Error('Commitment not found in tree');
const siblings = [], indices = [];
let _ci = leafIndex;
for (let i = 0; i < 16; i++) {
  siblings.push(i < _treeData.depth ? _treeData.levels[i][_ci ^ 1] : _treeData.zeros[i]);
  indices.push((leafIndex >> i) & 1);
  _ci >>= 1;
}
const pathData = { leafIndex, siblings, indices, root: _treeData.root, depth: _treeData.depth };
console.log('   leafIndex:', leafIndex, '| root from server:', pathData.root?.slice(0,20)+'...');

// Verify server root matches chain root
const serverRoot = BigInt(pathData.root);
const chainRoot = root;
console.log('   Root match:', serverRoot === chainRoot ? '✅' : '❌ MISMATCH');
if (serverRoot !== chainRoot) {
  console.log('   Server root:', serverRoot.toString());
  console.log('   Chain root:', chainRoot.toString());
  throw new Error('Root mismatch — server and chain disagree');
}

// Manually verify merkle path produces correct root
// Must use pathData.depth — not 16 — to match binary_merkle_root circuit behavior
const treeDepth = pathData.depth;
console.log('\n[6] Verifying merkle path locally (depth=' + treeDepth + ')...');
let current = commitment;
for (let i = 0; i < treeDepth; i++) {
  const sibling = BigInt(siblings[i]);
  let left, right;
  if (indices[i] === 0) { left = current; right = sibling; }
  else { left = sibling; right = current; }
  const hashFr = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
  current = frToBigInt(hashFr);
}
console.log('   Computed root:', current.toString().slice(0,20)+'...');
console.log('   On-chain root:', chainRoot.toString().slice(0,20)+'...');
console.log('   Root match:', current === chainRoot ? '✅ VERIFIED' : '❌ MISMATCH');

if (current !== chainRoot) throw new Error('Merkle path verification failed');

// Generate ZK proof
console.log('\n[7] Generating ZK proof...');
const circuit = await fetch(`${LOCAL_SERVER}/circuit`).then(r => r.json());
console.log('   Circuit loaded from server');

const backend = new UltraHonkBackend(circuit.bytecode);
const noir = new Noir(circuit);

const { witness } = await noir.execute({
  nullifier_hash: nullifierHash.toString(),
  root: chainRoot.toString(),
  depth: treeDepth,
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  indices: indices.map(String),
  siblings: siblings.map(String),
});
console.log('   Witness generated ✅');

const { proof } = await backend.generateProof(witness);
console.log('   Proof generated! bytes:', proof.length, '✅');

// Submit to local API
const proofHex = '0x' + Buffer.from(proof).toString('hex');
const nullifierHashHex = '0x' + nullifierHash.toString(16).padStart(64,'0');
const rootHex = '0x' + chainRoot.toString(16).padStart(64,'0');

console.log('\n[8] Submitting to API server...');
const res = await fetch(`${LOCAL_SERVER}/v1/chat`, {
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

if (res.status === 200) {
  console.log('\n=== ✅ E2E SUCCESS ===');
  console.log('LLM Reply:', data?.choices?.[0]?.message?.content);
} else {
  console.log('\n=== ❌ FAILED ===');
  console.log(JSON.stringify(data));
}

await bb.destroy();
