import { useScoreboard } from './scoreboardStore';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function LeaderboardOverlay({ open, onClose }: Props) {
  const { localPlayerId, entries } = useScoreboard();
  if (!open) return null;

  return (
    <div
      data-testid="leaderboard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Leaderboard"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(5, 12, 22, 0.72)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        color: '#edf6ff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 380,
          maxWidth: 'min(640px, 90vw)',
          maxHeight: '80vh',
          overflowY: 'auto',
          background: 'rgba(15, 23, 42, 0.92)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: '20px 24px',
          boxShadow: '0 18px 60px -10px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, letterSpacing: '0.05em' }}>
            Leaderboard
          </h2>
          <span style={{ fontSize: 11, opacity: 0.55, fontFamily: 'monospace' }}>
            Esc · Start
          </span>
        </div>
        {entries.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 14, padding: '12px 0' }}>
            No players yet.
          </div>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 14,
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: 'left',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  opacity: 0.45,
                }}
              >
                <th style={{ padding: '4px 8px 4px 0', fontWeight: 500 }}>Player</th>
                <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'right' }}>K</th>
                <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'right' }}>D</th>
                <th style={{ padding: '4px 0 4px 8px', fontWeight: 500, textAlign: 'right' }}>K/D</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isLocal = entry.playerId === localPlayerId || entry.isLocal;
                const ratio = entry.deaths === 0
                  ? (entry.kills === 0 ? '0.00' : `${entry.kills.toFixed(2)}`)
                  : (entry.kills / entry.deaths).toFixed(2);
                return (
                  <tr
                    key={entry.playerId}
                    style={{
                      background: isLocal ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                    }}
                  >
                    <td
                      style={{
                        padding: '6px 8px 6px 0',
                        fontWeight: isLocal ? 600 : 400,
                        color: isLocal ? '#7dd3fc' : (entry.isBot ? 'rgba(255,255,255,0.6)' : '#edf6ff'),
                      }}
                    >
                      {entry.username || `Player ${entry.playerId}`}
                      {entry.isBot ? (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(255,255,255,0.08)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                            opacity: 0.8,
                          }}
                        >
                          bot
                        </span>
                      ) : null}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {entry.kills}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {entry.deaths}
                    </td>
                    <td
                      style={{
                        padding: '6px 0 6px 8px',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        opacity: 0.75,
                      }}
                    >
                      {ratio}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
