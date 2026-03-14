#!/bin/bash
# updated.sh — Check what changed since last deploy
# Run this on the AWS box: bash ~/zk-api-credits/updated.sh

set -e

cd ~/zk-api-credits

echo "📦 Current local commit:"
git log -1 --oneline

echo ""
echo "🌐 Remote commits (unpulled):"
git fetch origin main -q
git log HEAD..origin/main --oneline

echo ""
echo "🐳 Running container:"
docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "✅ Health check:"
curl -s https://backend.zkllmapi.com/health | python3 -m json.tool

echo ""
echo "📋 Last 20 server logs:"
docker logs $(docker ps -q) --tail 20
