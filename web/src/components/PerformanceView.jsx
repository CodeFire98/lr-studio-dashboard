/* eslint-disable */
/* Performance — Linkrunner promo + blurred locked preview */
import React from 'react';
import { Icon } from './Icon.jsx';

const PerformanceView = () => {
  return (
    <div className="view"><div className="view-inner">
      <div className="perf-hero">
        <div className="tiny" style={{marginBottom: 12, color: "var(--accent-ink)"}}>Coming soon · Integration</div>
        <h2>See how your creatives <em>actually</em> perform.</h2>
        <p>Integrate with Linkrunner to pull attribution, engagement, and conversion data for every creative we deliver — directly into this dashboard.</p>
        <div className="ctas">
          <button className="btn btn-primary btn-lg">
            <Icon name="link" size={14}/>
            Connect Linkrunner
          </button>
          <a className="btn btn-ghost btn-lg" style={{color: "var(--ink-3)"}}>Learn more <Icon name="arrow-up-right" size={13}/></a>
        </div>
      </div>

      <div style={{marginTop: 48, marginBottom: 16, display: "flex", alignItems: "baseline", gap: 12}}>
        <div className="tiny">What you'll unlock</div>
        <div style={{flex: 1, height: 1, background: "var(--line)"}}/>
      </div>

      <div className="perf-locked">
        <div className="perf-locked-inner">
          <div className="metric-grid">
            <div className="metric">
              <div className="mk">Impressions</div>
              <div className="mv">1.24M</div>
              <div className="md">↑ 18.4% vs last 30d</div>
            </div>
            <div className="metric">
              <div className="mk">CTR</div>
              <div className="mv">2.81%</div>
              <div className="md">↑ 0.3 pts</div>
            </div>
            <div className="metric">
              <div className="mk">CAC</div>
              <div className="mv">$24.30</div>
              <div className="md" style={{color: "var(--good)"}}>↓ 12%</div>
            </div>
            <div className="metric">
              <div className="mk">Revenue attributed</div>
              <div className="mv">$184k</div>
              <div className="md">↑ 22%</div>
            </div>
          </div>
          <div className="fake-chart">
            <svg width="100%" height="100%" viewBox="0 0 800 220" preserveAspectRatio="none">
              <defs>
                <linearGradient id="perfg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#E8553D" stopOpacity="0.45"/>
                  <stop offset="1" stopColor="#E8553D" stopOpacity="0"/>
                </linearGradient>
              </defs>
              <path d="M0 170 C 80 140, 140 160, 220 120 S 380 80, 460 110 S 620 60, 800 40 L 800 220 L 0 220 Z" fill="url(#perfg)"/>
              <path d="M0 170 C 80 140, 140 160, 220 120 S 380 80, 460 110 S 620 60, 800 40" stroke="#E8553D" strokeWidth="2" fill="none"/>
            </svg>
          </div>
          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16}}>
            {["Top creative — Replenish 01","Top channel — Meta","Top campaign — Summer"].map((t) => (
              <div key={t} style={{padding: 16, border: "1px solid var(--line-2)", borderRadius: 12, background: "var(--surface-2)"}}>
                <div className="tiny">{t.split(" — ")[0]}</div>
                <div style={{fontFamily: "var(--font-serif)", fontSize: 22, marginTop: 4, letterSpacing: "-0.01em"}}>{t.split(" — ")[1]}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="perf-lock-overlay">
          <div className="lock-badge"><Icon name="lock" size={12}/> Connect Linkrunner to unlock</div>
          <div style={{fontFamily: "var(--font-serif)", fontSize: 28, color: "var(--ink-2)", letterSpacing: "-0.01em"}}>
            Attribution for every creative
          </div>
          <div style={{fontSize: 13, color: "var(--ink-3)", maxWidth: 380, textAlign: "center"}}>
            Measure what's working — per creative, channel, and campaign — without leaving this dashboard.
          </div>
        </div>
      </div>
    </div></div>
  );
};

export { PerformanceView };
