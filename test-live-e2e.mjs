/**
 * Live E2E test against mainnet contract + live backend
 * Uses deployer keystore (test wallet is EIP-7702 contract, rejects ETH)
 */
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import fs from 'fs';
const require = createRequire(import.meta.url);

process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');
const { Barretenberg, Fr, UltraHonkBackend } = await import(
  '/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js'
);
const { Noir } = require('/Users/austingriffith/clawd/zk-api-credits/packages/nextjs/node_modules/@noir-lang/noir_js/lib/index.cjs');
const { ethers } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/hardhat/node_modules/ethers/lib.esm/index.js');

const CONTRACT = '0x45284835Fe6eC9937Ce8db8AEE32F3E684f900F3';
const CLAWD    = '0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07';
const RPC      = 'https://base-mainnet.g.alchemy.com/v2/8GVG8WjDs-sGFRr6Rm839';
const API      = 'https://backend.zkllmapi.com';

const frToBigInt = (fr) => BigInt('0x' + Buffer.from(fr.value).toString('hex'));
const p2 = async (bb, a, b) => frToBigInt(await bb.poseidon2Hash([new Fr(a), new Fr(b)]));

// Load deployer from keystore (never prints key)
const ks = fs.readFileSync(process.env.HOME + '/.foundry/keystores/clawd-crash-deployer', 'utf-8');
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = (await ethers.Wallet.fromEncryptedJson(ks, 'clawdcrash2026!')).connect(provider);

const clawdAbi = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];
const contractAbi = [
  'function stake(uint256)',
  'function register(uint256)',
  'function stakedBalance(address) view returns (uint256)',
  'function getTreeData() view returns (uint256,uint256,uint256)',
  'function zeros(uint256) view returns (uint256)'
];

const clawd = new ethers.Contract(CLAWD, clawdAbi, wallet);
const api = new ethers.Contract(CONTRACT, contractAbi, wallet);

console.log('=== LIVE E2E TEST ===');
console.log('Wallet:', wallet.address, '\n');

const bb = await Barretenberg.new({ threads: 4 });
console.log('Barretenberg ready\n');

// Check balances
const clawdBal = await clawd.balanceOf(wallet.address);
const ethBal = await provider.getBalance(wallet.address);
const staked = await api.stakedBalance(wallet.address);
console.log('[1] ETH:', ethers.formatEther(ethBal));
console.log('    CLAWD:', ethers.formatEther(clawdBal));
console.log('    Staked:', ethers.formatEther(staked));

// Stake if needed
if (staked < ethers.parseEther('1000')) {
  const allowance = await clawd.allowance(wallet.address, CONTRACT);
  if (allowance < ethers.parseEther('1000')) {
    process.stdout.write('[2] Approving CLAWD... ');
    await (await clawd.approve(CONTRACT, ethers.parseEther('1000'))).wait();
    console.log('✅');
  }
  process.stdout.write('[2] Staking 1000 CLAWD... ');
  await (await api.stake(ethers.parseEther('1000'))).wait();
  console.log('✅');
} else {
  console.log('[2] Already staked ✅');
}

// Generate commitment
const nullifier = BigInt('0x' + randomBytes(31).toString('hex'));
const secret = BigInt('0x' + randomBytes(31).toString('hex'));
const commitment = frToBigInt(await bb.poseidon2Hash([new Fr(nullifier), new Fr(secret)]));
const nullifierHash = frToBigInt(await bb.poseidon2Hash([new Fr(nullifier)]));
console.log('\n[3] Commitment:', commitment.toString().slice(0,20)+'...');

// Register on-chain
process.stdout.write('[4] Registering on-chain... ');
const tx = await api.register(commitment);
await tx.wait();
console.log('✅', tx.hash);

const [treeSize, treeDepth, onChainRoot] = await api.getTreeData();
console.log(`    Tree: size=${treeSize}, depth=${treeDepth}, root=${onChainRoot.toString().slice(0,20)}...`);

// Fetch merkle path from live backend
process.stdout.write('\n[5] Merkle path from backend... ');
// Fetch full tree — path computed locally so server never sees which commitment we're using
const _treeRes = await fetch(`${API}/tree`);
const _treeData = await _treeRes.json();
if (_treeData.error) throw new Error('Tree error: ' + _treeData.error);
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
console.log('✅');

const serverRoot = BigInt(pathData.root);
const rootMatch = serverRoot === onChainRoot;
console.log(`    Server root match: ${rootMatch ? '✅' : '❌ MISMATCH'}`);
if (!rootMatch) { await bb.destroy(); process.exit(1); }

// Verify path locally
const { siblings, indices, depth } = pathData;
let node = commitment;
for (let i = 0; i < depth; i++) {
  node = indices[i] === 0
    ? await p2(bb, node, BigInt(siblings[i]))
    : await p2(bb, BigInt(siblings[i]), node);
}
const pathMatch = node === onChainRoot;
console.log(`    Path verify: ${pathMatch ? '✅' : '❌'}`);
if (!pathMatch) { await bb.destroy(); process.exit(1); }

// Generate ZK proof
console.log('\n[6] Generating ZK proof...');
const circuit = await fetch(`${API}/circuit`).then(r => r.json());
const backend = new UltraHonkBackend(circuit.bytecode);
const noir = new Noir(circuit);

process.stdout.write('    Witness... ');
const { witness } = await noir.execute({
  nullifier_hash: nullifierHash.toString(),
  root: onChainRoot.toString(),
  depth,
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  indices: indices.map(String),
  siblings: siblings.map(String),
});
console.log('✅');

process.stdout.write('    Proof... ');
const { proof, publicInputs } = await backend.generateProof(witness);
console.log(`✅ (${proof.length} bytes)`);

process.stdout.write('    Local verify... ');
const localOk = await backend.verifyProof({ proof, publicInputs });
console.log(localOk ? '✅' : '❌');
if (!localOk) { await bb.destroy(); process.exit(1); }

// Submit to live API
console.log('\n[7] Submitting to live API...');
const res = await fetch(`${API}/v1/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    proof: '0x' + Buffer.from(proof).toString('hex'),
    nullifier_hash: '0x' + nullifierHash.toString(16).padStart(64, '0'),
    root: '0x' + onChainRoot.toString(16).padStart(64, '0'),
    depth,
    messages: [{ role: 'user', content: 'Say exactly: "ZK proof verified. System is working."' }],
    model: 'llama-3.3-70b'
  })
});

const data = await res.json();
console.log('    Status:', res.status);

if (res.status === 200) {
  console.log('\n' + '='.repeat(60));
  console.log('✅ FULL LIVE E2E SUCCESS');
  console.log('LLM:', data?.choices?.[0]?.message?.content);
  console.log('='.repeat(60));
} else {
  console.log('\n❌ Error:', JSON.stringify(data, null, 2));
  await bb.destroy();
  process.exit(1);
}

await bb.destroy();
