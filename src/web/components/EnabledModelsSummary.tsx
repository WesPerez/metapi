import React from 'react';
import { ModelBadge } from './BrandIcon.js';

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = String(raw || '').trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

export default function EnabledModelsSummary({
  models,
  maxVisible,
  maxHeight = 96,
  emptyText = '暂无启用模型',
}: {
  models: unknown;
  maxVisible?: number;
  maxHeight?: number;
  emptyText?: string;
}) {
  const normalizedModels = normalizeModels(models);
  if (normalizedModels.length === 0) {
    return (
      <span className="badge badge-muted" style={{ fontSize: 11 }}>
        {emptyText}
      </span>
    );
  }

  const visibleCount =
    typeof maxVisible === 'number' && Number.isFinite(maxVisible)
      ? Math.max(1, Math.trunc(maxVisible))
      : normalizedModels.length;
  const visibleModels = normalizedModels.slice(0, visibleCount);
  const remainingCount = normalizedModels.length - visibleModels.length;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        maxHeight,
        overflowY: 'auto',
      }}
      data-tooltip={normalizedModels.join(' / ')}
    >
      {visibleModels.map((model) => (
        <ModelBadge
          key={model}
          model={model}
          style={{
            maxWidth: 180,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        />
      ))}
      {remainingCount > 0 ? (
        <span className="badge badge-muted" style={{ fontSize: 11 }}>
          +{remainingCount}
        </span>
      ) : null}
      <span
        style={{
          fontSize: 11,
          color: 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
        }}
      >
        共 {normalizedModels.length} 个
      </span>
    </div>
  );
}
