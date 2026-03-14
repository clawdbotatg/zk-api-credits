process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');
const { Barretenberg, Fr } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');
const frToBigInt = (fr) => BigInt('0x' + Buffer.from(fr.value).toString('hex'));
const bb = await Barretenberg.new({ threads: 1 });

const leaf = 7988038963173566799961278734990429934770372435596852371494595847870204524860n;
const siblings = [0n, 0n, 888450782164500443683569237062189421849106102066658965484615222328808179605n];
const indices = [0, 0, 1];
const depth = 3;
const onChainRoot = 1007122981507073298743944908764923807708080226866128561853766130184406299112n;

// Try standard binary merkle (always hash, even with 0 sibling)
console.log('=== Standard binary merkle (always hash) ===');
let node = leaf;
for (let i = 0; i < depth; i++) {
  const sibling = siblings[i];
  let left, right;
  if (indices[i] === 0) { left = node; right = sibling; }
  else { left = sibling; right = node; }
  const hashFr = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
  node = frToBigInt(hashFr);
  console.log(`  level ${i}: hash(${left.toString().slice(0,10)}, ${right.toString().slice(0,10)}) = ${node.toString().slice(0,20)}`);
}
console.log('Result:', node.toString());
console.log('Expected:', onChainRoot.toString());
console.log('Match:', node === onChainRoot ? '✅' : '❌');

// Try LeanIMT behavior (skip hash when sibling is 0 — promote node up)
console.log('\n=== LeanIMT (skip hash when sibling=0) ===');
node = leaf;
for (let i = 0; i < depth; i++) {
  const sibling = siblings[i];
  if (sibling === 0n) {
    // LeanIMT: no sibling, promote node up without hashing
    console.log(`  level ${i}: promoted (no sibling)`);
    continue;
  }
  let left, right;
  if (indices[i] === 0) { left = node; right = sibling; }
  else { left = sibling; right = node; }
  const hashFr = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
  node = frToBigInt(hashFr);
  console.log(`  level ${i}: hash = ${node.toString().slice(0,20)}`);
}
console.log('Result:', node.toString());
console.log('Match:', node === onChainRoot ? '✅' : '❌');

await bb.destroy();
