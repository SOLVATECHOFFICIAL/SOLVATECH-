import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, Check, CircleHelp, Link2, Radio, WifiOff } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
type ConnectionState = 'idle' | 'pending' | 'connected' | 'error';

type BotStatus = {
  state: ConnectionState;
  number: string;
  message: string;
};

function readString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseStatus(payload: unknown): BotStatus {
  const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const rawState = readString(data, ['status', 'state', 'connection']).toLowerCase();
  const number = readString(data, ['connectedNumber', 'phoneNumber', 'number', 'phone', 'jid']);
  const connected = data.connected === true || data.isConnected === true || rawState === 'connected' || rawState === 'open' || rawState === 'online';
  const pending = rawState === 'pairing' || rawState === 'pending' || rawState === 'connecting' || rawState === 'awaiting_pairing';
  const failed = rawState === 'error' || rawState === 'disconnected' || rawState === 'failed';
  const message = readString(data, ['message', 'detail', 'error']);

  return {
    state: connected ? 'connected' : pending ? 'pending' : failed ? 'error' : 'idle',
    number,
    message,
  };
}

function parsePairResponse(payload: unknown) {
  const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const code = readString(data, ['pairingCode', 'pairCode', 'code', 'pairing_code']);
  const number = readString(data, ['connectedNumber', 'phoneNumber', 'number', 'phone']);
  return { code, number, message: readString(data, ['message', 'detail']) };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function readResponse(response: Response) {
  const text = await response.text();
  let payload: unknown = {};
  try {
    if (text) payload = JSON.parse(text);
  } catch {
    if (text.trim().startsWith('<')) {
      throw new Error('Server returned an HTML response instead of JSON. Please check backend connection.');
    }
  }
  if (!response.ok) {
    const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    throw new Error(readString(data, ['message', 'error']) || `Request failed with ${response.status}`);
  }
  return payload;
}

const RAILWAY_URL = 'https://web-production-215ab.up.railway.app';
const isSelfHosted = typeof window !== 'undefined' && (
  window.location.hostname.includes('railway.app') ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.includes('run.app')
);
const DEFAULT_BACKEND_URL = isSelfHosted ? window.location.origin : RAILWAY_URL;
function getApiUrl(path: string) {
  let custom = typeof window !== 'undefined' ? (localStorage.getItem('solvatech_backend_url') || '') : '';
  if (custom && (
    custom.includes('3c1de8') ||
    custom.includes('localhost:5000') ||
    (!isSelfHosted && typeof window !== 'undefined' && (custom.includes(window.location.hostname) || custom.includes('solvatech.name.ng')))
  )) {
    try { localStorage.removeItem('solvatech_backend_url'); } catch {}
    custom = '';
  }
  const baseUrl = (custom || DEFAULT_BACKEND_URL).replace(/\/$/, '');
  const cleanPath = path.startsWith('/api/') ? path.replace(/^\/api/, '/bot-api') : path;
  return `${baseUrl}${cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath}`;
}

function Home() {
  const [phone, setPhone] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [status, setStatus] = useState<BotStatus>({ state: 'idle', number: '', message: '' });
  const [error, setError] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const fetchStatus = useCallback(async (quiet = false) => {
    try {
      const response = await fetch(getApiUrl('/bot-api/status'), { headers: { Accept: 'application/json' } });
      const payload = await readResponse(response);
      setStatus(parseStatus(payload));
      if (!quiet) setError('');
    } catch (requestError) {
      if (!quiet) setError(getErrorMessage(requestError, 'Live status is temporarily unavailable.'));
    }
  }, []);

  useEffect(() => {
    void fetchStatus(true);
    const interval = window.setInterval(() => void fetchStatus(true), 4000);
    return () => window.clearInterval(interval);
  }, [fetchStatus]);

  const normalizedPhone = useMemo(() => phone.replace(/[^\d+]/g, ''), [phone]);
  const canPair = normalizedPhone.replace(/\D/g, '').length >= 7 && !isPairing;

  async function handlePair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPair) return;
    setIsPairing(true);
    setError('');
    setPairCode('');
    setStatus((current) => ({ ...current, state: 'pending', message: 'Requesting a pairing code…' }));
    try {
      const response = await fetch(getApiUrl('/bot-api/pair'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ number: normalizedPhone }),
      });
      const payload = await readResponse(response);
      const result = parsePairResponse(payload);
      if (!result.code && result.message) setStatus((current) => ({ ...current, message: result.message }));
      if (result.code) setPairCode(result.code);
      if (result.number) setStatus((current) => ({ ...current, number: result.number }));
      await fetchStatus();
    } catch (requestError) {
      const message = getErrorMessage(requestError, 'We could not generate a pairing code.');
      setError(message);
      setStatus((current) => ({ ...current, state: 'error', message }));
    } finally {
      setIsPairing(false);
    }
  }

  async function handleDisconnect() {
    if (isDisconnecting) return;
    setIsDisconnecting(true);
    setError('');
    try {
      const response = await fetch(getApiUrl('/bot-api/disconnect'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      await readResponse(response);
      setPairCode('');
      setStatus({ state: 'idle', number: '', message: 'The bot is ready for a new connection.' });
      await fetchStatus(true);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'We could not disconnect this session.'));
    } finally {
      setIsDisconnecting(false);
    }
  }

  const statusCopy = {
    idle: { badge: 'Ready to pair', value: 'Not connected', detail: 'Enter your WhatsApp number to start a secure pairing session.' },
    pending: { badge: 'Waiting for phone', value: 'Pairing in progress', detail: status.message || 'Open WhatsApp on your phone and enter the code shown here.' },
    connected: { badge: 'Connected', value: 'Session is live', detail: 'Your WhatsApp Multi-Device session is active and ready.' },
    error: { badge: 'Needs attention', value: 'Connection paused', detail: status.message || 'Try again to start a new pairing request.' },
  }[status.state];

  return (
    <div className="bot-shell">
      <header className="topbar">
        <a className="brand" href="/" data-testid="link-brand">
          <span className="brand-mark" aria-hidden="true">S/</span>
          <span className="brand-copy">
            <span className="brand-name">SOLVATECH BOT</span>
            <span className="brand-owner">BY SOLVATECHOFFICIAL</span>
          </span>
        </a>
        <div className="topbar-note" data-testid="text-console-status">PAIRING CONSOLE / LIVE</div>
      </header>

      <main className="bot-main">
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow"><span className="eyebrow-line" /> WhatsApp Multi-Device</p>
          <h1 id="page-title">Connect your phone.<br /><em>Keep it clear.</em></h1>
          <p className="hero-lede">A focused pairing console for SOLVATECH BOT. Request a code, link your WhatsApp account, and see the connection come alive.</p>
        </section>

        <section className="console-grid" aria-label="Bot pairing console">
          <article className="surface pair-card">
            <div className="card-heading">
              <div>
                <p className="card-kicker">01 / Start a session</p>
                <h2 className="card-title">Get your pairing code</h2>
              </div>
              <span className="step-number">01—02</span>
            </div>
            <form className="pair-form" onSubmit={handlePair}>
              <label className="input-label" htmlFor="whatsapp-number">WhatsApp number</label>
              <div className="phone-input-wrap">
                <span className="phone-prefix" aria-hidden="true">+</span>
                <input
                  id="whatsapp-number"
                  className="phone-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="234 801 234 5678"
                  value={phone.replace(/^\+/, '')}
                  onChange={(event) => setPhone(event.target.value.replace(/[^\d+ ]/g, ''))}
                  aria-describedby="number-hint"
                  data-testid="input-whatsapp-number"
                />
              </div>
              <p className="input-hint" id="number-hint">Include your country code. Do not add spaces or a leading zero after the code.</p>
              <button className="primary-action" type="submit" disabled={!canPair} data-testid="button-get-pairing-code">
                {isPairing ? 'Requesting code' : 'Get Pairing Code'}
                {!isPairing && <ArrowRight className="arrow-icon" size={18} strokeWidth={1.8} aria-hidden="true" />}
              </button>
            </form>
            {pairCode && (
              <div className="code-panel" data-testid="text-pairing-code">
                <p className="code-panel-label">Your pairing code</p>
                <p className="pair-code">{pairCode}</p>
                <p className="pair-code-meta">Enter this code in WhatsApp → Linked devices → Link a device → Link with phone number, then keep this page open while the session finishes connecting.</p>
              </div>
            )}
            {error && <div className="error-message" role="alert" data-testid="text-pairing-error"><AlertCircle size={14} aria-hidden="true" /> {error}</div>}
          </article>

          <aside className="surface status-card" aria-live="polite">
            <div className="status-top">
              <p className="status-label">02 / Live status</p>
              <span className={`status-badge is-${status.state}`} data-testid="status-connection">{statusCopy.badge}</span>
            </div>
            <div className="status-value-row">
              <h2 className={`status-value ${status.state === 'connected' ? 'connected' : ''}`} data-testid="text-connection-state">{statusCopy.value}</h2>
              <div className="state-orbit" aria-hidden="true">
                {status.state === 'connected' ? <Check size={25} strokeWidth={1.8} /> : status.state === 'error' ? <WifiOff size={23} strokeWidth={1.7} /> : <Radio size={23} strokeWidth={1.7} />}
              </div>
            </div>
            <p className="status-detail" data-testid="text-status-detail">{statusCopy.detail}</p>
            <div className="status-divider" />
            <p className="number-label">Connected number</p>
            <p className="connected-number" data-testid="text-connected-number">{status.number || '—'}</p>
            <button className="disconnect-action" type="button" disabled={status.state !== 'connected' || isDisconnecting} onClick={handleDisconnect} data-testid="button-disconnect">
              {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </aside>
        </section>

        <section className="surface instructions" aria-labelledby="instructions-title">
          <div className="instructions-heading">
            <h2 className="instructions-title" id="instructions-title">Pairing, in three clear moves.</h2>
            <span className="instructions-note">NO APP DOWNLOAD REQUIRED</span>
          </div>
          <ol className="instruction-list">
            <li className="instruction-step">
              <span className="instruction-index">01</span>
              <span className="instruction-copy"><strong>Enter your number</strong><span>Use the full international format for the WhatsApp account you want to connect.</span></span>
            </li>
            <li className="instruction-step">
              <span className="instruction-index">02</span>
              <span className="instruction-copy"><strong>Request a code</strong><span>Tap Get Pairing Code. Your one-time code will appear here when ready.</span></span>
            </li>
            <li className="instruction-step">
              <span className="instruction-index">03</span>
              <span className="instruction-copy"><strong>Link in WhatsApp</strong><span>WhatsApp → Linked devices → Link a device → Link with phone number.</span></span>
            </li>
          </ol>
          <div className="notice" data-testid="text-security-notice">
            <CircleHelp size={15} aria-hidden="true" />
            <span>Your number is used only to establish this session. Keep your pairing code private.</span>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>© SOLVATECHOFFICIAL</span>
        <span><Link2 size={11} aria-hidden="true" /> SECURE SESSION / WHATSAPP MD</span>
      </footer>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;