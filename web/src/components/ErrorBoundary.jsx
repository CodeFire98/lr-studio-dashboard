/* eslint-disable */
/* Top-level error boundary — catches render errors from any view so a single
   bad query doesn't white-screen the whole app. */
import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error?.message || String(this.state.error);
    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 32,
        fontFamily: 'var(--font-sans, system-ui)',
        background: 'var(--bg, #FAFAF7)',
        color: 'var(--ink, #17171A)',
      }}>
        <div style={{maxWidth: 520, textAlign: 'left'}}>
          <div style={{
            fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--accent-ink, #C4412C)', marginBottom: 12,
          }}>Something went sideways</div>
          <h1 style={{
            fontFamily: 'var(--font-serif, serif)',
            fontSize: 40, lineHeight: 1.1, margin: '0 0 16px',
          }}>
            We hit a snag rendering the page.
          </h1>
          <p style={{fontSize: 14, color: 'var(--ink-3, #6B6A6B)', marginBottom: 20}}>
            The error below has been logged to the browser console. If this keeps
            happening, copy it to your L+R contact.
          </p>
          <pre style={{
            background: 'var(--surface-2, #F6F5F0)',
            border: '1px solid var(--line, #E6E3DC)',
            borderRadius: 10,
            padding: 14,
            fontSize: 12,
            color: 'var(--ink-2, #3A3A3F)',
            overflow: 'auto',
            maxHeight: 200,
            whiteSpace: 'pre-wrap',
          }}>{message}</pre>
          <div style={{display: 'flex', gap: 10, marginTop: 20}}>
            <button
              onClick={this.reset}
              style={{
                padding: '10px 16px',
                background: 'var(--accent, #E8553D)',
                color: 'var(--accent-contrast, #fff)',
                border: 0, borderRadius: 10, fontSize: 14, cursor: 'pointer',
              }}
            >Try again</button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 16px',
                background: 'transparent',
                color: 'var(--ink, #17171A)',
                border: '1px solid var(--line, #E6E3DC)', borderRadius: 10,
                fontSize: 14, cursor: 'pointer',
              }}
            >Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

export { ErrorBoundary };
