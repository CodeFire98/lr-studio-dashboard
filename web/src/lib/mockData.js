/* eslint-disable */
/* =========================================================
   Mock Data — Luma DTC skincare brand
   Structured so it can be swapped for real API calls later.
   ========================================================= */

const MOCK = (() => {

  // ----- Users / people -----
  const people = {
    you: {
      id: "u_maya",
      name: "Maya Okafor",
      initials: "MO",
      role: "Brand Lead, Luma",
      email: "maya@luma.co",
      avatarColor: "#E8553D",
    },
    admin: {
      id: "u_admin",
      name: "Ren Takahashi",
      initials: "RT",
      role: "Creative Lead, L+R",
      email: "ren@landr.studio",
      avatarColor: "#2B2B2E",
    },
    people: [
      { id: "u_elsa", name: "Elsa Marchetti", initials: "EM", role: "Art Director", avatarColor: "#C4412C" },
      { id: "u_jun", name: "Jun Park", initials: "JP", role: "Motion Designer", avatarColor: "#6579BE" },
      { id: "u_ade", name: "Ade Oyelaran", initials: "AO", role: "Copywriter", avatarColor: "#3E8864" },
      { id: "u_sana", name: "Sana Ito", initials: "SI", role: "Photographer", avatarColor: "#C88A3F" },
      { id: "u_dev", name: "Devika Rao", initials: "DR", role: "Project Manager", avatarColor: "#8B5CF6" },
    ],
  };

  // ----- Brand kit (Luma) -----
  const brand = {
    name: "Luma",
    tagline: "Skin-first. Science-backed. Unapologetically calm.",
    mission: "Make a quiet, considered routine the new baseline for skin health — no hype, no smoke, no miracle claims.",
    audience: "Women 28–45 in major US & UK cities. Design-conscious, ingredient-curious, brand-loyal once earned. Over-indexed on editorial media (Cereal, The Gentlewoman, Vogue) and ambient IG accounts.",
    palette: [
      { name: "Ink", hex: "#1B1F1C", role: "Primary text" },
      { name: "Clay", hex: "#C9A88B", role: "Secondary" },
      { name: "Shell", hex: "#F4EBDD", role: "Background" },
      { name: "Moss", hex: "#5E6A52", role: "Accent" },
      { name: "Peach", hex: "#F3B79A", role: "Highlight" },
      { name: "Cream", hex: "#FBF6ED", role: "Canvas" },
    ],
    fonts: [
      { family: "Söhne", role: "UI / Body", sample: "The quiet weight of considered typography." },
      { family: "Canela Deck", role: "Display", sample: "Skin, softly." },
    ],
    voiceTags: ["Warm", "Precise", "Confident, not loud", "Less is more", "Ingredient-first"],
    dos: [
      "Lead with skin outcomes, not hype",
      "Write like a knowledgeable friend",
      "Use clean, natural product photography",
      "Reference ingredients by name, briefly",
    ],
    donts: [
      "Miracle claims or medical language",
      "Heavy retouching or unreal skin",
      "Jargon-heavy ingredient lists",
      "Emoji in hero copy",
    ],
    logos: [
      { id: "lg1", label: "Primary · Wordmark", variant: "wordmark", bg: "#FBF6ED", ink: "#1B1F1C" },
      { id: "lg2", label: "Secondary · Monogram", variant: "mono", bg: "#FBF6ED", ink: "#1B1F1C" },
      { id: "lg3", label: "Mono · Reverse", variant: "wordmark", bg: "#1B1F1C", ink: "#FBF6ED" },
    ],
    assets: [
      { id: "a1", label: "Brand Guidelines v2.4", kind: "PDF", size: "18 MB", updated: "Mar 12" },
      { id: "a2", label: "Tone of Voice", kind: "DOC", size: "420 KB", updated: "Feb 02" },
      { id: "a3", label: "Ingredient Story Deck", kind: "PDF", size: "32 MB", updated: "Jan 18" },
    ],
    photography: [
      { id: "ph1", palette: ["#F3E7D6", "#E8C9A8", "#C8A184"], kicker: "Ritual" },
      { id: "ph2", palette: ["#E8DFD1", "#CABBA3", "#7F7866"], kicker: "Product" },
      { id: "ph3", palette: ["#EFE9DD", "#D6C4A5", "#A78B6B"], kicker: "Texture" },
      { id: "ph4", palette: ["#F4EBDD", "#C9A88B", "#1B1F1C"], kicker: "Hero" },
      { id: "ph5", palette: ["#E6E2D6", "#B9A989", "#5E6A52"], kicker: "Still life" },
      { id: "ph6", palette: ["#F6EEE4", "#F3B79A", "#C4412C"], kicker: "Morning" },
    ],
    inspiration: [
      { id: "i1", label: "Aesop storefront — Marais", palette: ["#E8DFD1", "#7F7866", "#1B1F1C"] },
      { id: "i2", label: "Le Labo — fragrance lab", palette: ["#F4EBDD", "#C9A88B", "#5E6A52"] },
      { id: "i3", label: "Cereal mag — issue 24", palette: ["#FBF6ED", "#C9A88B", "#1B1F1C"] },
      { id: "i4", label: "Muji — packaging", palette: ["#FBF6ED", "#E8DFD1", "#7F7866"] },
    ],
    pastCreatives: [
      { id: "pc1", label: "Gentle Cleanser — Launch", palette: ["#F4EBDD", "#C9A88B", "#1B1F1C"] },
      { id: "pc2", label: "Replenish — Teaser", palette: ["#F3E7D6", "#F3B79A", "#C4412C"] },
      { id: "pc3", label: "Spring Cleanse", palette: ["#EFE9DD", "#D6C4A5", "#A78B6B"] },
      { id: "pc4", label: "Founder Essay", palette: ["#E6E2D6", "#B9A989", "#5E6A52"] },
    ],
    aiSummary:
      "Luma is a premium DTC skincare brand built around a minimalist 4-step routine. Your customers are women 28–45 who value ingredient transparency and calm, editorial aesthetics. Creative should feel gallery-quiet, warm-toned, and ingredient-led — never glossy or hyperbolic.",
  };

  // ----- Creative artwork (procedural placeholder generator) -----
  // Each returns an SVG <defs> and body — used inline by <Art>.
  const palettes = [
    ["#F3E7D6", "#E8C9A8", "#C8A184"],  // peach clay
    ["#E8DFD1", "#CABBA3", "#7F7866"],  // shell taupe
    ["#EFE9DD", "#D6C4A5", "#A78B6B"],  // cream wheat
    ["#F4EBDD", "#E8553D", "#1B1F1C"],  // luma accent
    ["#E6E2D6", "#B9A989", "#5E6A52"],  // moss cream
    ["#F6EEE4", "#F3B79A", "#C4412C"],  // coral dust
    ["#ECE5D8", "#94A088", "#3E4A3E"],  // forest haze
    ["#F8F1E4", "#D4B996", "#8E6B4A"],  // honey
  ];

  // ----- Tasks -----
  const tasks = [
    {
      id: "p_launch",
      title: "Replenish Serum — Launch Campaign",
      tag: "Product Launch",
      status: "progress",
      deadline: "May 12",
      deadlineDate: "2026-05-12",
      createdAt: "Apr 14",
      creativeLead: people.people[0],
      collaborators: [people.people[0], people.people[1], people.people[2]],
      palette: palettes[3],
      artKicker: "Replenish",
      artLabel: "Drop 01 — May",
      brief: {
        message:
          "We need 10 creatives for the Replenish Serum launch. Due May 12. Static and motion for Instagram and TikTok. Objective: awareness + waitlist signups. Tone: quiet, editorial, ingredient-led.",
        chips: {
          count: { value: 10, unit: "creatives" },
          deadline: { value: "May 12" },
          format: { value: "Static + motion" },
          platform: { value: "Instagram, TikTok" },
          objective: { value: "Awareness + waitlist" },
          tone: { value: "Quiet, editorial" },
          audience: { value: "Women 28–45, ingredient-led" },
          keyMessage: { value: "New serum drops May 12. Join the waitlist." },
          aspectRatios: { value: "1:1, 9:16" },
        },
      },
      deliverables: [
        { id: "d1", label: "IG Post — 01", type: "static", version: "v2", palette: palettes[3] },
        { id: "d2", label: "IG Post — 02", type: "static", version: "v1", palette: palettes[5] },
        { id: "d3", label: "IG Post — 03", type: "static", version: "v2", palette: palettes[0] },
        { id: "d4", label: "TikTok Opener", type: "motion", version: "v3", palette: palettes[3] },
        { id: "d5", label: "TikTok Close", type: "motion", version: "v1", palette: palettes[2] },
      ],
      thread: [
        { from: "them", who: people.admin, time: "Apr 14 · 10:12", text: "Hi Maya — Ren here from L+R. We've kicked off the Replenish launch. Elsa is leading art direction; Jun's on motion. Initial concepts by Monday." },
        { from: "me", who: people.you, time: "Apr 14 · 11:02", text: "Amazing. Quick note: please keep product shots crop-tight, no faces for drop 01. We're saving the model work for drop 02." },
        { from: "them", who: people.people[0], time: "Apr 18 · 09:40", text: "First concept batch is up in Deliverables. Three static directions — \"Drop,\" \"Layered,\" and \"Negative Space.\" Let us know which to push." },
        { from: "me", who: people.you, time: "Apr 18 · 14:18", text: "Loving \"Negative Space.\" Can we kill the gradient background on Drop? Feels too glossy for Luma." },
        { from: "them", who: people.people[0], time: "Apr 20 · 08:25", text: "Refreshed both. v2 is live — solid off-white grounds across the set." },
      ],
    },
    {
      id: "p_tiktok",
      title: "5 Instagram posts — trending: 'dewy not oily'",
      tag: "Social Trend",
      status: "review",
      deadline: "Apr 25",
      deadlineDate: "2026-04-25",
      createdAt: "Apr 19",
      creativeLead: people.people[2],
      collaborators: [people.people[2], people.people[4]],
      palette: palettes[5],
      artKicker: "Social",
      artLabel: "Trend pack",
      brief: {
        message: "5 Instagram posts riding the 'dewy not oily' conversation. Needs to ship by Friday.",
        chips: {
          count: { value: 5, unit: "posts" },
          deadline: { value: "Apr 25" },
          format: { value: "Static" },
          platform: { value: "Instagram" },
          objective: { value: "Engagement" },
          tone: { value: "Conversational" },
        },
      },
      deliverables: [
        { id: "td1", label: "Reel Cover — 01", type: "static", version: "v1", palette: palettes[5] },
        { id: "td2", label: "Reel Cover — 02", type: "static", version: "v1", palette: palettes[0] },
        { id: "td3", label: "Reel Cover — 03", type: "static", version: "v1", palette: palettes[6] },
      ],
      thread: [
        { from: "them", who: people.people[2], time: "Apr 19 · 14:30", text: "Took a pass at 5 covers. Copy is playful but on-brand — take a look when you have a minute." },
        { from: "me", who: people.you, time: "Apr 21 · 09:15", text: "In review with the team. Will respond by EOD." },
      ],
    },
    {
      id: "p_photo",
      title: "Summer '26 lifestyle photography set",
      tag: "Photography",
      status: "progress",
      deadline: "Jun 03",
      deadlineDate: "2026-06-03",
      createdAt: "Apr 02",
      creativeLead: people.people[3],
      collaborators: [people.people[3], people.people[0]],
      palette: palettes[0],
      artKicker: "Summer '26",
      artLabel: "Lifestyle set",
      brief: {
        message: "Lifestyle photography set for the brand. 30 hero images plus supporting. Warm natural light, minimal props, outdoor + home interior.",
        chips: {
          count: { value: 30, unit: "images" },
          deadline: { value: "Jun 3" },
          format: { value: "Photography" },
          platform: { value: "Web + Social" },
          objective: { value: "Brand library refresh" },
          tone: { value: "Warm, unposed" },
        },
      },
      deliverables: [
        { id: "pd1", label: "Moodboard", type: "document", version: "v2", palette: palettes[0] },
        { id: "pd2", label: "Shot list", type: "document", version: "v1", palette: palettes[2] },
      ],
      thread: [
        { from: "them", who: people.people[3], time: "Apr 08 · 11:00", text: "Moodboard attached. Pulling from Joshua Tree + LA bungalow references. Shoot date proposed May 18–19." },
      ],
    },
    {
      id: "p_holiday",
      title: "Mother's Day gift guide campaign",
      tag: "Seasonal",
      status: "delivered",
      deadline: "Apr 15",
      deadlineDate: "2026-04-15",
      createdAt: "Mar 22",
      creativeLead: people.people[0],
      collaborators: [people.people[0], people.people[2]],
      palette: palettes[6],
      artKicker: "Mother's Day",
      artLabel: "Delivered Apr 15",
      brief: {
        message: "Quick Mother's Day campaign: 6 creatives, email headers, 2 landing page banners. Soft and personal.",
        chips: {
          count: { value: 6, unit: "creatives" },
          deadline: { value: "Apr 15" },
          format: { value: "Static" },
          platform: { value: "Email, Web" },
          objective: { value: "Conversion" },
        },
      },
      deliverables: [
        { id: "hd1", label: "Email Header", type: "static", version: "v2", palette: palettes[6] },
        { id: "hd2", label: "Landing Banner", type: "static", version: "v2", palette: palettes[2] },
        { id: "hd3", label: "Social 01", type: "static", version: "v1", palette: palettes[6] },
        { id: "hd4", label: "Social 02", type: "static", version: "v1", palette: palettes[0] },
      ],
      thread: [
        { from: "them", who: people.people[0], time: "Apr 15 · 16:00", text: "Everything is delivered 🌿 Let us know how the campaign performs — happy to iterate." },
      ],
    },
    {
      id: "p_refresh",
      title: "Weekly ad creative refresh — Meta",
      tag: "Performance",
      status: "revising",
      deadline: "Apr 26",
      deadlineDate: "2026-04-26",
      createdAt: "Apr 20",
      creativeLead: people.people[1],
      collaborators: [people.people[1], people.people[2]],
      palette: palettes[7],
      artKicker: "Weekly",
      artLabel: "Ad refresh · W17",
      brief: {
        message: "Weekly refresh: 8 new variants for our top-performing Meta ad set. Swap imagery + hooks, keep format.",
        chips: {
          count: { value: 8, unit: "variants" },
          deadline: { value: "Apr 26" },
          format: { value: "Motion + static" },
          platform: { value: "Meta" },
          objective: { value: "Conversion" },
        },
      },
      deliverables: [
        { id: "rd1", label: "Variant A1", type: "static", version: "v1", palette: palettes[7] },
        { id: "rd2", label: "Variant A2", type: "static", version: "v1", palette: palettes[4] },
      ],
      thread: [
        { from: "me", who: people.you, time: "Apr 21 · 10:00", text: "Need copy variants on A1 — the hook is too soft for cold audiences." },
        { from: "them", who: people.people[2], time: "Apr 21 · 13:30", text: "On it. Shipping 3 sharper hooks by tomorrow AM." },
      ],
    },
  ];

  // ----- Library (delivered creatives, across tasks) -----
  const library = [
    { id: "l1", title: "Mother's Day — Email Header", project: "Mother's Day", type: "Static", date: "Apr 15", palette: palettes[6] },
    { id: "l2", title: "Mother's Day — Landing", project: "Mother's Day", type: "Static", date: "Apr 15", palette: palettes[2] },
    { id: "l3", title: "Mother's Day — Social 01", project: "Mother's Day", type: "Static", date: "Apr 15", palette: palettes[6] },
    { id: "l4", title: "Mother's Day — Social 02", project: "Mother's Day", type: "Static", date: "Apr 15", palette: palettes[0] },
    { id: "l5", title: "Spring Cleanse — Hero", project: "Spring Cleanse", type: "Static", date: "Mar 28", palette: palettes[2] },
    { id: "l6", title: "Spring Cleanse — Motion", project: "Spring Cleanse", type: "Motion", date: "Mar 28", palette: palettes[4] },
    { id: "l7", title: "Cleanser launch — IG", project: "Gentle Cleanser", type: "Static", date: "Feb 18", palette: palettes[1] },
    { id: "l8", title: "Cleanser launch — Reel", project: "Gentle Cleanser", type: "Motion", date: "Feb 18", palette: palettes[7] },
    { id: "l9", title: "Winter Routine — 01", project: "Winter Routine", type: "Static", date: "Jan 10", palette: palettes[6] },
    { id: "l10", title: "Winter Routine — 02", project: "Winter Routine", type: "Static", date: "Jan 10", palette: palettes[5] },
    { id: "l11", title: "Founder essay — Hero", project: "Brand", type: "Photography", date: "Dec 18", palette: palettes[1] },
    { id: "l12", title: "Ingredient Deck — 01", project: "Brand", type: "Copy", date: "Dec 10", palette: palettes[2] },
    { id: "l13", title: "Year-end Thanks", project: "Holiday '25", type: "Static", date: "Dec 02", palette: palettes[3] },
    { id: "l14", title: "Gift Guide Cover", project: "Holiday '25", type: "Static", date: "Nov 25", palette: palettes[7] },
    { id: "l15", title: "Gift Guide Video", project: "Holiday '25", type: "Motion", date: "Nov 25", palette: palettes[4] },
  ];

  // ----- Team (org) -----
  const team = [
    { ...people.you, role: "Admin", status: "Active" },
    { id: "t1", name: "Noor Ansari", initials: "NA", email: "noor@luma.co", role: "Requester", status: "Active", avatarColor: "#C88A3F" },
    { id: "t2", name: "Felix Grimaldi", initials: "FG", email: "felix@luma.co", role: "Reviewer", status: "Active", avatarColor: "#6579BE" },
    { id: "t3", name: "Priya Shenoy", initials: "PS", email: "priya@luma.co", role: "Requester", status: "Active", avatarColor: "#3E8864" },
    { id: "t4", name: "Tomás Vega", initials: "TV", email: "tomas@luma.co", role: "Reviewer", status: "Pending", avatarColor: "#8B5CF6" },
  ];

  // ----- Admin queue (L+R internal) -----
  const adminQueue = [
    { id: "q1", taskId: "p_launch", urgency: "hot", lastActivity: "4h ago", note: "Waiting for refreshed v2 concepts review." },
    { id: "q2", taskId: "p_tiktok", urgency: "warm", lastActivity: "8h ago", note: "First round in review with Luma team." },
    { id: "q3", taskId: "p_refresh", urgency: "hot", lastActivity: "1h ago", note: "Maya requested sharper hooks on A1." },
    { id: "q4", taskId: "p_photo", urgency: "cool", lastActivity: "2d ago", note: "Shoot dates pending confirmation." },
  ];

  const templates = [
    { text: "10 creatives for a product launch", icon: "grid" },
    { text: "5 Instagram posts for a trending topic", icon: "spark" },
    { text: "Lifestyle photography set for my brand", icon: "aperture" },
    { text: "Refresh my ad creatives for this week", icon: "refresh" },
    { text: "A campaign concept for an upcoming holiday", icon: "calendar" },
    { text: "3 hero banner options", icon: "layout" },
  ];

  return { people, brand, tasks, library, team, adminQueue, templates, palettes };
})();

export default MOCK;
