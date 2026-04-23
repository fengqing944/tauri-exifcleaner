import type { ReactNode } from "react";

import type { BadgeTone } from "../app-shared";

export function Panel(props: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.aside}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

export function StatusBadge(props: { tone: BadgeTone; label: string }) {
  return <span className={`badge ${props.tone}`}>{props.label}</span>;
}

export function StatChip(props: { label: string; value: string }) {
  return (
    <div className="stat-chip">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

export function EmptyBox(props: { title: string; description: string }) {
  return (
    <div className="empty-box">
      <strong>{props.title}</strong>
      <span>{props.description}</span>
    </div>
  );
}
