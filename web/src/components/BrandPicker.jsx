/* eslint-disable */
/* BrandPicker — sidebar dropdown that anchors the entire navigation.
   Whatever brand is selected here scopes Calendar, Tasks, Library, Brand
   Intelligence, etc. Two flavours:

   - Brand owner: shows the brands they belong to + "Create new brand."
     Selecting a brand calls auth.setActiveBrand (preserves existing flow).

   - Agency: shows "All clients" sentinel + every brand account + "Add a
     client" + "Manage clients." Selecting drives `activeAdminBrandId`
     in App state, persisted to localStorage. Replaces the old shadow-
     impersonation mechanism. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

export const ALL_CLIENTS = '__all__';

// Show the search input once the agency manages enough brands that
// scrolling becomes annoying. Below this threshold we hide it to keep
// the dropdown compact.
const SEARCH_THRESHOLD = 6;

const SwatchDot = ({ color }) => (
  <span
    aria-hidden
    style={{
      width: 10,
      height: 10,
      borderRadius: 3,
      background: color || 'var(--ink-4)',
      flexShrink: 0,
    }}
  />
);

const BrandPicker = ({
  isAgency,
  activeAdminBrandId,   // agency: '__all__' | uuid
  brandAccounts,        // agency: [{ id, name, accentColor }] (loadBrandAccounts shape)
  // Brand-owner data
  auth,
  // Handlers
  onSelectBrand,        // (id) => void — id may be '__all__' for agency
  onCreateBrand,        // () => Promise<newAccountId | null>
  onManageClients,      // agency only
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the search box every time the menu opens, and focus it so the
  // admin can start typing immediately. Filter is case-insensitive.
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    setTimeout(() => searchRef.current?.focus(), 0);
  }, [open]);

  const showSearch = isAgency && (brandAccounts || []).length >= SEARCH_THRESHOLD;
  const filteredBrands = useMemo(() => {
    const list = brandAccounts || [];
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((b) => (b.name || '').toLowerCase().includes(q));
  }, [brandAccounts, query]);

  // Resolve current selection label + swatch.
  const display = (() => {
    if (isAgency) {
      if (activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId) {
        return { label: 'All clients', color: 'var(--ink-3)' };
      }
      const match = (brandAccounts || []).find((b) => b.id === activeAdminBrandId);
      return {
        label: match?.name || 'Brand',
        color: match?.accentColor || 'var(--ink-4)',
      };
    }
    return {
      label: auth?.account?.name || 'Brand',
      color: auth?.account?.accentColor || 'var(--ink-4)',
    };
  })();

  const memberships = auth?.memberships || [];

  return (
    <div className="brand-picker" ref={wrapRef}>
      <button
        type="button"
        className={'brand-picker-pill' + (open ? ' open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <SwatchDot color={display.color}/>
        <span className="brand-picker-label">{display.label}</span>
        <Icon name="chevron-down" size={13}/>
      </button>

      {open && (
        <div className="brand-picker-menu" role="listbox">
          {isAgency ? (
            <>
              {showSearch && (
                <div className="brand-picker-search-wrap">
                  <Icon name="search" size={12}/>
                  <input
                    ref={searchRef}
                    type="search"
                    className="brand-picker-search"
                    placeholder="Search clients…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
                  />
                </div>
              )}
              {!query && (
                <button
                  type="button"
                  role="option"
                  aria-selected={activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId}
                  className={'brand-picker-row' + ((activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId) ? ' is-current' : '')}
                  onClick={() => { setOpen(false); onSelectBrand?.(ALL_CLIENTS); }}
                >
                  <Icon name="grid" size={13}/>
                  <span style={{ flex: 1 }}>All clients</span>
                  {(activeAdminBrandId === ALL_CLIENTS || !activeAdminBrandId) && (
                    <Icon name="check" size={13}/>
                  )}
                </button>
              )}
              {!query && <div className="brand-picker-sep"/>}
              {!query && <div className="brand-picker-section-label">Clients</div>}
              {filteredBrands.length === 0 ? (
                <div className="brand-picker-empty">
                  {query ? `No clients match "${query.trim()}".` : 'No clients yet.'}
                </div>
              ) : (
                filteredBrands.map((b) => {
                  const isCurrent = activeAdminBrandId === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      className={'brand-picker-row' + (isCurrent ? ' is-current' : '')}
                      onClick={() => { setOpen(false); onSelectBrand?.(b.id); }}
                    >
                      <SwatchDot color={b.accentColor || 'var(--ink-4)'}/>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {b.name}
                      </span>
                      {isCurrent && <Icon name="check" size={13}/>}
                    </button>
                  );
                })
              )}
              <div className="brand-picker-sep"/>
              <button
                type="button"
                className="brand-picker-row"
                onClick={async () => {
                  setOpen(false);
                  const newId = await onCreateBrand?.();
                  if (newId) onSelectBrand?.(newId);
                }}
              >
                <Icon name="plus" size={13}/>
                <span>Add a client</span>
              </button>
              <button
                type="button"
                className="brand-picker-row"
                onClick={() => { setOpen(false); onManageClients?.(); }}
              >
                <Icon name="settings" size={13}/>
                <span>Manage clients</span>
              </button>
            </>
          ) : (
            <>
              {memberships.length === 0 ? (
                // Brand-owner with their auth-bound brand only — show it as
                // a current row so the menu isn't oddly empty.
                <button
                  type="button"
                  role="option"
                  aria-selected
                  className="brand-picker-row is-current"
                  disabled
                >
                  <SwatchDot color={auth?.account?.accentColor || 'var(--ink-4)'}/>
                  <span style={{ flex: 1 }}>{auth?.account?.name || 'Brand'}</span>
                  <Icon name="check" size={13}/>
                </button>
              ) : (
                memberships.map((m) => {
                  const isCurrent = m.account.id === auth?.account?.id;
                  return (
                    <button
                      key={m.account.id}
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      className={'brand-picker-row' + (isCurrent ? ' is-current' : '')}
                      onClick={() => { setOpen(false); onSelectBrand?.(m.account.id); }}
                    >
                      <SwatchDot color={m.account.accentColor || 'var(--ink-4)'}/>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.account.name}
                      </span>
                      {isCurrent && <Icon name="check" size={13}/>}
                    </button>
                  );
                })
              )}
              <div className="brand-picker-sep"/>
              <button
                type="button"
                className="brand-picker-row"
                onClick={async () => {
                  setOpen(false);
                  const newId = await onCreateBrand?.();
                  if (newId) onSelectBrand?.(newId);
                }}
              >
                <Icon name="plus" size={13}/>
                <span>Create new brand</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export { BrandPicker };
