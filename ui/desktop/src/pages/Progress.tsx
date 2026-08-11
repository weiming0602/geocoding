import { MILESTONES } from '../../../shared/milestones';

export default function Progress() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 4 }}>Progress</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
        A running record of what's shipped so far, and what's next.
      </p>

      <div>
        {MILESTONES.map((milestone, i) => (
          <div key={milestone.title} style={{ display: 'flex', gap: 'var(--space-4)' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                width: 12,
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: milestone.current ? 'transparent' : 'var(--color-accent)',
                  border: milestone.current ? '2px solid var(--color-accent)' : 'none',
                }}
              />
              {i < MILESTONES.length - 1 && (
                <div style={{ width: 1, flex: 1, background: 'var(--color-divider)', marginTop: 4 }} />
              )}
            </div>
            <div style={{ paddingBottom: 'var(--space-6)' }}>
              <div className="card-kicker">{milestone.date}</div>
              <h3 style={{ margin: '2px 0 4px' }}>
                {milestone.title}
                {milestone.current && (
                  <span className="tag tag-accent" style={{ marginLeft: 'var(--space-2)' }}>
                    In progress
                  </span>
                )}
              </h3>
              <p className="text-muted" style={{ margin: 0 }}>
                {milestone.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
