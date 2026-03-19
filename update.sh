#!/bin/bash
# update.sh — Pull latest code and redeploy the ZK API Credits server
# Run this on the AWS box: bash ~/zk-api-credits/update.sh

set -e

echo "🔄 Pulling latest code..."
cd ~/zk-api-credits
git pull

echo "🔍 Patching RPC/WS URLs (Alchemy)..."
ALCHEMY_KEY="AlQf7KFYpAw_AlE4oCP85"
for VAR_VALUE in \
  "RPC_URL=https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" \
  "WS_URL=wss://base-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY"; do
  VAR="${VAR_VALUE%%=*}"
  if grep -q "^$VAR=" packages/api-server/.env 2>/dev/null; then
    sed -i "s|^$VAR=.*|$VAR_VALUE|" packages/api-server/.env
  else
    echo "$VAR_VALUE" >> packages/api-server/.env
  fi
done
echo "   ✅ RPC/WS updated"

echo "🔍 Syncing contract address from zkllmapi.com..."
CONTRACT=$(curl -s https://zkllmapi.com/contract | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])" 2>/dev/null)
if [ -z "$CONTRACT" ]; then
  CONTRACT="0xE476F94c93FF5385F84a29b4647fE122604814AB"
  echo "⚠️  Could not fetch from zkllmapi.com, using fallback: $CONTRACT"
else
  echo "   Contract: $CONTRACT"
  # Update or add CONTRACT_ADDRESS in .env
  if grep -q "CONTRACT_ADDRESS" packages/api-server/.env 2>/dev/null; then
    sed -i "s/CONTRACT_ADDRESS=.*/CONTRACT_ADDRESS=$CONTRACT/" packages/api-server/.env
  else
    echo "CONTRACT_ADDRESS=$CONTRACT" >> packages/api-server/.env
  fi
  echo "   ✅ .env updated"
fi

echo "🐳 Rebuilding Docker image (build context: repo root)..."
docker stop $(docker ps -q) 2>/dev/null || true
docker rm $(docker ps -aq) 2>/dev/null || true

# Build from repo root so Dockerfile can access both api-server/ and circuits/
docker build -f packages/api-server/Dockerfile -t zk-api-server .

echo "🚀 Starting server..."
docker run -d -p 3001:3001 \
  --env-file packages/api-server/.env \
  -v $(pwd)/packages/api-server/data:/app/data \
  --restart unless-stopped \
  zk-api-server

echo "⏳ Waiting for server to start..."
sleep 5

echo "✅ Health check..."
curl -s https://backend.zkllmapi.com/health | python3 -m json.tool

echo ""
echo "✅ Circuit check..."
curl -s https://backend.zkllmapi.com/circuit | head -c 80
echo ""
echo ""
echo "🎉 Done!"
