#!/bin/bash

# 清理 release.yml 工作流的所有历史运行
# Usage: ./scripts/cleanup-workflow-runs.sh

set -e

OWNER="CMDRKilmer"
REPO="RUNCN"
WORKFLOW="release.yml"

echo "🗑️  开始清理 $WORKFLOW 的所有历史运行..."
echo ""

# 获取所有工作流运行
RUNS=$(gh run list \
  --repo "$OWNER/$REPO" \
  --workflow "$WORKFLOW" \
  --limit 100 \
  --json databaseId \
  --jq '.[].databaseId')

if [ -z "$RUNS" ]; then
  echo "✅ 没有工作流运行需要清理"
  exit 0
fi

TOTAL=$(echo "$RUNS" | wc -l)
DELETED=0

echo "找到 $TOTAL 个工作流运行，开始删除..."
echo ""

for RUN_ID in $RUNS; do
  echo -n "删除运行 ID: $RUN_ID ... "
  if gh run delete "$RUN_ID" --repo "$OWNER/$REPO" 2>/dev/null; then
    echo "✅"
    ((DELETED++))
  else
    echo "❌ (可能已删除)"
  fi
done

echo ""
echo "🎉 清理完成！已删除 $DELETED/$TOTAL 个工作流运行"
