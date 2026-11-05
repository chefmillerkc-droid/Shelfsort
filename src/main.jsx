import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// v0.7.8 launch-loop escape hatch: until now, ANY render throw
// (e.g. a malformed book record in the Library list) unmounted the
// whole app with no recovery — and since the Library is the launch
// view, the user could never reach Settings to turn off the startup
// scan that might be contributing. This boundary catches render
// errors and offers two plain actions instead of a dead app: turn
// off the startup scan and reload (which breaks a scan-related
// launch loop without touching the library — no data is cleared),
// or just reload.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#eee', background: '#1e1e1e', minHeight: '100vh' }}>
          <h1>ShelfSort hit a display problem</h1>
          <p>The Library could not be drawn — your books are still saved on the phone; nothing has been deleted.</p>
          <p style={{ opacity: 0.7, fontSize: 13 }}>{String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
            <button
              style={{ padding: '12px 18px', fontSize: 16 }}
              onClick={() => {
                try {
                  localStorage.setItem('shelfsort-scan-on-startup', 'off')
                  localStorage.removeItem('shelfsort-startup-scan-in-progress')
                } catch { /* ignore */ }
                window.location.reload()
              }}
            >
              Turn off startup scan and reload
            </button>
            <button style={{ padding: '12px 18px', fontSize: 16 }} onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
          <p style={{ opacity: 0.7, fontSize: 13 }}>If the app still will not open after turning off the startup scan, the problem is in the Library display itself — report the message above.</p>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
