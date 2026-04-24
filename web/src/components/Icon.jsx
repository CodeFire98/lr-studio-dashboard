/* eslint-disable */
/* Icon primitives — tiny line SVGs, editorial weight */
import React from 'react';

const Icon = ({ name, size = 16, stroke = 1.6, ...rest }) => {
  const s = size;
  const sw = stroke;
  const common = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round",
    ...rest,
  };
  switch (name) {
    case "home": return (<svg {...common}><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>);
    case "folder": return (<svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>);
    case "brand": return (<svg {...common}><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>);
    case "library": return (<svg {...common}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>);
    case "calendar": return (<svg {...common}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>);
    case "chart": return (<svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>);
    case "team": return (<svg {...common}><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M21 20c0-2.5-1.8-4.5-4-5"/></svg>);
    case "settings": return (<svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.4 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.4-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>);
    case "plus": return (<svg {...common}><path d="M12 5v14M5 12h14"/></svg>);
    case "x": return (<svg {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>);
    case "check": return (<svg {...common}><path d="M5 12.5 10 17l9-9.5"/></svg>);
    case "arrow-right": return (<svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>);
    case "arrow-up-right": return (<svg {...common}><path d="M7 17 17 7M8 7h9v9"/></svg>);
    case "chevron-down": return (<svg {...common}><path d="m6 9 6 6 6-6"/></svg>);
    case "chevron-right": return (<svg {...common}><path d="m9 6 6 6-6 6"/></svg>);
    case "paperclip": return (<svg {...common}><path d="m21 12-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/></svg>);
    case "send": return (<svg {...common}><path d="M4 12 20 4l-7 16-2-7-7-1z"/></svg>);
    case "sparkles": return (<svg {...common}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>);
    case "search": return (<svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>);
    case "filter": return (<svg {...common}><path d="M3 5h18M6 12h12M10 19h4"/></svg>);
    case "grid": return (<svg {...common}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>);
    case "list": return (<svg {...common}><path d="M4 6h16M4 12h16M4 18h16"/></svg>);
    case "download": return (<svg {...common}><path d="M12 4v12M6 12l6 6 6-6M4 20h16"/></svg>);
    case "lock": return (<svg {...common}><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>);
    case "invite": return (<svg {...common}><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3.1-6.5 7-6.5s7 3 7 6.5"/><path d="M19 8v6M16 11h6"/></svg>);
    case "reply": return (<svg {...common}><path d="M10 8 5 13l5 5"/><path d="M5 13h10a5 5 0 0 1 5 5v1"/></svg>);
    case "upload": return (<svg {...common}><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>);
    case "sun": return (<svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>);
    case "moon": return (<svg {...common}><path d="M20 14.5A8 8 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>);
    case "refresh": return (<svg {...common}><path d="M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3"/><path d="M17 4v4h-4M7 20v-4h4"/></svg>);
    case "aperture": return (<svg {...common}><circle cx="12" cy="12" r="9"/><path d="M14.3 4.3 9 21M3.6 8.5 21 9M5 17.5 16 3M21 14.5 8 15M18.5 18.5 11 6"/></svg>);
    case "layout": return (<svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>);
    case "spark": return (<svg {...common}><path d="M12 3v4M12 17v4M4 12h4M16 12h4M7 7l2 2M15 15l2 2M7 17l2-2M15 9l2-2"/></svg>);
    case "image": return (<svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m21 15-5-5-11 11"/></svg>);
    case "more": return (<svg {...common}><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>);
    case "sliders": return (<svg {...common}><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/></svg>);
    case "eye": return (<svg {...common}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>);
    case "comment": return (<svg {...common}><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>);
    case "clock": return (<svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>);
    case "flag": return (<svg {...common}><path d="M5 21V4M5 4h12l-2 3 2 3H5"/></svg>);
    case "link": return (<svg {...common}><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></svg>);
    case "chevron-up": return (<svg {...common}><path d="m6 15 6-6 6 6"/></svg>);
    case "arrow-left": return (<svg {...common}><path d="M19 12H5M11 5 4 12l7 7"/></svg>);
    case "logout": return (<svg {...common}><path d="M10 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>);
    case "login": return (<svg {...common}><path d="M14 5h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/><path d="m8 17-5-5 5-5M3 12h12"/></svg>);
    case "close": return (<svg {...common}><path d="M18 6 6 18M6 6l12 12"/></svg>);
    case "user": return (<svg {...common}><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>);
    case "shield": return (<svg {...common}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/></svg>);
    default: return (<svg {...common}><rect x="3" y="3" width="18" height="18" rx="4"/></svg>);
  }
};

export { Icon };
