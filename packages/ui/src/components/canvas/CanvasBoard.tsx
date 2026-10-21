import type { CanvasBlock, CanvasSpec } from '@celeste/protocol';

import { Icon } from '../Icon';

/**
 * The visual canvas.
 *
 * A board of blocks the panel draws itself - not an HTML page in an iframe.
 * It renders in the panel's own type and colour, follows the light/dark
 * theme, and can be edited a block at a time.
 */

function number(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/* -------------------------------------------------------------------------- */
/* Charts                                                                     */
/* -------------------------------------------------------------------------- */

function BarChart({ labels, values, unit }: { labels: string[]; values: number[]; unit?: string }) {
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  return (
    <div className="canvas-chart canvas-chart--bar">
      {values.map((value, index) => (
        <div className="canvas-chart__bar-item" key={`${labels[index] ?? index}`}>
          <div className="canvas-chart__bar-track">
            <div
              className="canvas-chart__bar-fill"
              style={{ height: `${Math.max((Math.abs(value) / max) * 100, 2)}%` }}
            />
          </div>
          <span className="canvas-chart__bar-value">
            {number(value)}
            {unit ?? ''}
          </span>
          <span className="canvas-chart__bar-label">{labels[index] ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

function LineChart({ labels, values, unit }: { labels: string[]; values: number[]; unit?: string }) {
  const width = 320;
  const height = 120;
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  const min = Math.min(...values.map((v) => Math.abs(v)), 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width / 2;
    const y = height - ((Math.abs(value) - min) / span) * (height - 16) - 8;
    return { x, y };
  });

  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
  const area = `${path} L${points[points.length - 1]?.x ?? 0},${height} L${points[0]?.x ?? 0},${height} Z`;

  return (
    <div className="canvas-chart canvas-chart--line">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Line chart">
        <path className="canvas-chart__area" d={area} />
        <path className="canvas-chart__line" d={path} />
        {points.map((point, index) => (
          <circle key={index} className="canvas-chart__dot" cx={point.x} cy={point.y} r={3} />
        ))}
      </svg>
      <div className="canvas-chart__axis">
        {labels.map((label, index) => (
          <span key={`${label}-${index}`}>
            {label}
            {index === labels.length - 1 ? (
              <strong>
                {number(values[index] ?? 0)}
                {unit ?? ''}
              </strong>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function DonutChart({ labels, values, unit }: { labels: string[]; values: number[]; unit?: string }) {
  const total = values.reduce((sum, value) => sum + Math.abs(value), 0) || 1;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="canvas-chart canvas-chart--donut">
      <svg viewBox="0 0 140 140" role="img" aria-label="Donut chart">
        {values.map((value, index) => {
          const share = (Math.abs(value) / total) * circumference;
          const dash = `${share} ${circumference - share}`;
          const rotation = (offset / circumference) * 360 - 90;
          offset += share;
          return (
            <circle
              key={index}
              className="canvas-chart__slice"
              cx={70}
              cy={70}
              r={radius}
              fill="none"
              strokeWidth={22}
              strokeDasharray={dash}
              transform={`rotate(${rotation} 70 70)`}
            />
          );
        })}
        <text className="canvas-chart__donut-total" x={70} y={66} textAnchor="middle">
          {number(total)}
          {unit ?? ''}
        </text>
        <text className="canvas-chart__donut-caption" x={70} y={84} textAnchor="middle">
          total
        </text>
      </svg>
      <ul className="canvas-chart__legend">
        {labels.map((label, index) => (
          <li key={`${label}-${index}`}>
            <span className="canvas-chart__legend-dot" data-index={index} />
            {label}
            <strong>
              {number(values[index] ?? 0)}
              {unit ?? ''}
            </strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

function Block({ block }: { block: CanvasBlock }) {
  switch (block.type) {
    case 'heading': {
      const Tag = (block.level === 3 ? 'h4' : block.level === 2 ? 'h3' : 'h2') as 'h2' | 'h3' | 'h4';
      return <Tag className="canvas-heading">{block.text}</Tag>;
    }
    case 'text':
      return (
        <p className={`canvas-text${block.tone && block.tone !== 'default' ? ` canvas-text--${block.tone}` : ''}`}>
          {block.text}
        </p>
      );
    case 'kpi':
      return (
        <div className="canvas-kpi">
          <span className="canvas-kpi__label">{block.label}</span>
          <span className="canvas-kpi__value">{block.value}</span>
          {block.delta ? (
            <span className={`canvas-kpi__delta canvas-kpi__delta--${block.trend}`}>
              {block.trend === 'up' ? '▲' : block.trend === 'down' ? '▼' : '■'} {block.delta}
            </span>
          ) : null}
        </div>
      );
    case 'chart':
      return (
        <figure className="canvas-panel">
          {block.title ? <figcaption className="canvas-panel__title">{block.title}</figcaption> : null}
          {block.chart === 'bar' ? (
            <BarChart labels={block.labels} values={block.values} unit={block.unit} />
          ) : block.chart === 'line' ? (
            <LineChart labels={block.labels} values={block.values} unit={block.unit} />
          ) : (
            <DonutChart labels={block.labels} values={block.values} unit={block.unit} />
          )}
        </figure>
      );
    case 'table':
      return (
        <figure className="canvas-panel canvas-panel--table">
          {block.title ? <figcaption className="canvas-panel__title">{block.title}</figcaption> : null}
          <div className="canvas-table-wrap">
            <table className="canvas-table">
              <thead>
                <tr>
                  {block.columns.map((column, index) => (
                    <th key={`${column}-${index}`}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );
    case 'image':
      return (
        <figure className="canvas-panel canvas-panel--image">
          <img src={block.url} alt={block.alt ?? block.caption ?? ''} loading="lazy" />
          {block.caption ? <figcaption className="canvas-panel__title">{block.caption}</figcaption> : null}
        </figure>
      );
    case 'list':
      return (
        <div className="canvas-panel canvas-panel--list">
          {block.title ? <div className="canvas-panel__title">{block.title}</div> : null}
          {block.ordered ? (
            <ol className="canvas-list">
              {block.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ol>
          ) : (
            <ul className="canvas-list">
              {block.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'quote':
      return (
        <blockquote className="canvas-quote">
          <p>{block.text}</p>
          {block.cite ? <cite>{block.cite}</cite> : null}
        </blockquote>
      );
    case 'code':
      return (
        <pre className="canvas-code">
          <code>{block.code}</code>
        </pre>
      );
    case 'divider':
      return <hr className="canvas-divider" />;
    case 'spacer':
      return <div className={`canvas-spacer canvas-spacer--${block.size ?? 'md'}`} />;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Board                                                                      */
/* -------------------------------------------------------------------------- */

export interface CanvasBoardProps {
  spec: CanvasSpec;
  title?: string;
}

export function CanvasBoard({ spec, title }: CanvasBoardProps) {
  const kpis = spec.blocks.filter((block) => block.type === 'kpi');
  const rest = spec.blocks.filter((block) => block.type !== 'kpi');

  return (
    <article className={`canvas-board${spec.theme === 'dark' ? ' canvas-board--dark' : ''}`}>
      <header className="canvas-board__head">
        {spec.eyebrow ? <p className="canvas-board__eyebrow">{spec.eyebrow}</p> : null}
        <h1 className="canvas-board__title">{spec.title ?? title ?? 'Canvas'}</h1>
        {spec.subtitle ? <p className="canvas-board__subtitle">{spec.subtitle}</p> : null}
      </header>

      {kpis.length > 0 ? (
        <div className="canvas-board__kpis">
          {kpis.map((block, index) => (
            <Block key={index} block={block} />
          ))}
        </div>
      ) : null}

      <div className="canvas-board__body">
        {rest.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </div>

      <footer className="canvas-board__foot">
        <Icon name="sparkle" size={12} />
        Built by Celeste
      </footer>
    </article>
  );
}
