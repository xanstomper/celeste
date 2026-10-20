import { useState } from 'react';
import type { Artifact } from '@celeste/protocol';

import { formatBytes, formatRelativeTime } from '../lib/format';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface ArtifactCardProps {
  artifact: Artifact;
}

const KIND_ICON: Record<Artifact['kind'], IconName> = {
  docx: 'file',
  pdf: 'file',
  xlsx: 'file',
  pptx: 'file',
  md: 'file',
  txt: 'file',
  json: 'terminal',
  csv: 'list',
  other: 'file',
};

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function directoryOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '';
}

/**
 * A card for a file the agent produced.
 */
export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const [copied, setCopied] = useState(false);
  const directory = directoryOf(artifact.path);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(artifact.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="artifact">
      <span className={`artifact__icon artifact__icon--${artifact.kind}`}>
        <Icon name={KIND_ICON[artifact.kind] ?? 'file'} size={16} />
      </span>

      <div className="artifact__body">
        <p className="artifact__name" title={artifact.path}>
          {fileName(artifact.path)}
        </p>
        <p className="artifact__meta">
          <span className="artifact__kind">{artifact.kind.toUpperCase()}</span>
          <span className="artifact__dot">·</span>
          <span>{formatBytes(artifact.bytes)}</span>
          <span className="artifact__dot">·</span>
          <span>{formatRelativeTime(artifact.createdAt)}</span>
        </p>
        {artifact.description ? <p className="artifact__desc">{artifact.description}</p> : null}
        {directory ? <p className="artifact__path">{directory}</p> : null}
      </div>

      <button
        type="button"
        className="button button--tiny button--ghost"
        onClick={() => void copyPath()}
        aria-label={`Copy path of ${fileName(artifact.path)}`}
        title="Copy path"
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        {copied ? 'Copied' : 'Copy path'}
      </button>
    </article>
  );
}
