/**
 * Verify merkle path using binary_merkle_root logic (matches circuit exactly)
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');
const { Barretenberg, Fr } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');
const { ethers } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/hardhat/node_modules/ethers/lib.esm/index.js');

const frToBigInt = (fr) => BigInt('0x' + Buffer.from(fr.value).toString('hex'));
const bb = await Barretenberg.new({ threads: 1 });

// Get on-chain state
const provider = new ethers.JsonRpcProvider('https://base-mainnet.g.alchemy.com/v2/8GVG8WjDs-sGFRr6Rm839');
const api = new ethers.Contract(
  '0x234d536e1623546F394707D6dB700f9c8CD29476',
  [
    'function getTreeData() view returns (uint256,uint256,uint256)',
    'event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)'
  ],
  provider
);

const [size, treeDepth, root] = await api.getTreeData();
console.log('Tree size:', size.toString(), '| depth:', treeDepth.toString(), '| root:', root.toString().slice(0,20)+'...');

// Get events to find leaves
const events = await provider.getLogs({
  address: '0x234d536e1623546F394707D6dB700f9c8CD29476',
  topics: ['0x7de7691ba02c3c903aa6686e4a566130f54d23b424ef7ab590f865a6027e1056'],
  fromBlock: 0n,
  toBlock: 'latest'
});

const iface = new ethers.Interface(['event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)']);
const leaves = [];
for (const e of events) {
  const decoded = iface.parseLog(e);
  leaves[Number(decoded.args.index)] = decoded.args.commitment;
  console.log(`  leaf[${decoded.args.index}]:`, decoded.args.commitment.toString().slice(0,20)+'...');
}

// Get merkle path for last leaf
const lastLeaf = leaves[leaves.length - 1];
console.log('\nFetching path for leaf:', lastLeaf.toString().slice(0,20)+'...');
const pathRes = await fetch(`http://localhost:3002/merkle-path/${lastLeaf.toString()}`);
const { leafIndex, siblings, indices, root: serverRoot, depth } = await pathRes.json();
console.log('leafIndex:', leafIndex, '| depth:', depth, '| serverRoot:', serverRoot?.slice(0,20)+'...');

// Manually recompute using binary_merkle_root logic (matches circuit)
// Only hash up to 'depth' levels, not all 16
let node = lastLeaf;
console.log('\nManual root computation:');
for (let i = 0; i < depth; i++) {
  const sibling = BigInt(siblings[i]);
  let left, right;
  if (indices[i] === 0) { left = node; right = sibling; }
  else { left = sibling; right = node; }
  const hashFr = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
  node = frToBigInt(hashFr);
  console.log(`  level ${i}: hash([${indices[i]===0?'node':'sibling'}, ${indices[i]===0?'sibling':'node'}]) = ${node.toString().slice(0,20)}...`);
}

console.log('\nComputed root:', node.toString());
console.log('On-chain root:', root.toString());
console.log('Match:', node === root ? '✅ MATCH' : '❌ MISMATCH');

await bb.destroy();
