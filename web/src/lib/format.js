/* eslint-disable */
/* Small shared formatters. Currently money + dates; can grow as more
   surfaces need consistent output. Kept dependency-free so every view
   can pull from here without dragging extra imports. */

const MONEY_LOCALE = {
  USD: 'en-US',
  INR: 'en-IN',
};

// formatMoney(1500, 'INR') → "₹1,500.00"
// formatMoney(1500, 'USD') → "$1,500.00"
// Returns the raw number stringified when currency is unknown or Intl
// rejects the code, so the caller never crashes on bad data.
function formatMoney(amount, currency) {
  const value = Number(amount);
  const code = (currency || '').toUpperCase();
  const locale = MONEY_LOCALE[code] || 'en-US';
  if (!Number.isFinite(value)) return '';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code || 'USD',
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(value);
  } catch (_) {
    return `${code} ${value.toFixed(2)}`;
  }
}

// formatDateShort('2026-06-15') → "Jun 15, 2026"
function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export { formatMoney, formatDateShort };
