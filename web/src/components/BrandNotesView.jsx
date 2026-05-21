// =====================================================================
// BrandNotesView — top-level page for the agency's brand memory notes
// =====================================================================
//
// Mounted at /c/:slug/notes (sidebar entry "Brand notes", agency-only,
// positioned below "Trends Radar"). Wraps the existing BrandNotesSection
// in standard page chrome — title, sub, and the same view / view-inner
// layout the other surfaces use.
//
// Why a dedicated view (instead of leaving it inside BrandKitView):
//
// Brand notes are an agency thinking-out-loud surface — raw memory like
// "the founder hates the word authentic", "Q3 launch is the new bamboo
// onesie line", "no holiday content before Oct 15". They drive the AI
// LinkAI's brand context on every call. Burying them inside the
// otherwise-customer-facing Brand Intelligence page conflated two
// audiences and two purposes. Giving notes their own page makes the
// surface easier to find, gives it room to grow (search / filtering /
// tags later), and removes a non-agency-facing card from BrandKitView.
//
// AGENCY ONLY. The sidebar entry only renders for agency users, but if
// a brand user manually navigates to /c/:slug/notes we want a graceful
// empty state rather than the section's full UI failing on RLS. The
// inner component (BrandNotesSection) already returns null for non-
// agency callers, so we render a small "not available" line instead.
// =====================================================================

/* eslint-disable */
import React from 'react';
import { BrandNotesSection } from './BrandNotesSection.jsx';
import { readAuth } from '../lib/auth.js';

const BrandNotesView = ({ accountId, brandName }) => {
  const auth = readAuth() || {};
  // Both agency AND brand teammates can view/write notes for their
  // own brand as of migration 0052. We still surface the boolean for
  // any per-role nuance BrandNotesSection wants downstream, but the
  // view-level "not available" gate is gone.
  const isAgency = !!auth.isAgency;

  if (!accountId) {
    return (
      <div className="view"><div className="view-inner">
        <div className="page-head"><div className="titles"><h1>Brand notes</h1>
          <div className="sub">
            Pick a brand from the sidebar to see its memory notes.
          </div>
        </div></div>
      </div></div>
    );
  }

  return (
    <div className="view"><div className="view-inner">
      <div className="page-head"><div className="titles">
        <h1>Brand notes</h1>
        <div className="sub">
          Long-term memory the LinkAI reads on every call for
          <strong>{brandName ? ` ${brandName}` : ' this brand'}</strong>.
          Pin always-true facts so they ride along on every call;
          unpinned notes are time-bound and decay out of the brand-
          context window after the ~20-most-recent cap.
        </div>
      </div></div>
      <BrandNotesSection
        accountId={accountId}
        isAgency={isAgency}
        userId={auth?.id}
      />
    </div></div>
  );
};

export { BrandNotesView };
