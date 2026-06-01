# Linkrunner Media — AI Image Generation Prompting Guide

A system-level reference for creating high-quality, brand-accurate AI image generation prompts across all client brands. Use this as the foundation before writing any prompt.

---

## The Golden Rules

1. **Always state the format first** — 4:5, 1:1, or 16:9. Never leave this ambiguous.
2. **Always reference the product image** — tell the tool to use the attached product as reference. Never describe the product from memory.
3. **Proportions must be accurate** — state the real-world dimensions of the product (e.g., "330ml glass bottle, approximately 22cm tall").
4. **Label must be front and centre** — always state "label facing directly at camera, completely readable, front and centre."
5. **No faces unless specified** — default to waist-down, hands only, or torso-only unless faces are explicitly needed.
6. **Specify the sharpest element** — tell the tool what should be in focus. The product is almost always the answer.
7. **Name the light** — harsh midday, golden hour, soft diffused, studio. Never assume.
8. **End with the product reference line** — always close the prompt with "Use [product name] as exact product reference for bottle shape, label design, liquid colour, and proportions."

---

## Prompt Architecture

Every prompt should follow this structure, in this order:

```
1. FORMAT
2. SHOT TYPE / ANGLE
3. SUBJECT (person, hands, product placement)
4. PRODUCT DETAILS (proportions, label, liquid colour, cap)
5. HUMAN ELEMENTS (skin tone, nails, jewellery, clothing)
6. BACKGROUND / SETTING
7. PROPS (if any)
8. LIGHTING
9. MOOD / FEEL
10. CAMERA STYLE
11. PRODUCT REFERENCE LINE
```

---

## Format Specifications

Always start with one of these:

| Format | Use Case |
|---|---|
| `"4:5 format (vertical)."` | Instagram feed posts, lifestyle shots |
| `"Square format (1:1)."` | Product shots, flat lays, carousels |
| `"16:9 format (landscape)."` | LinkedIn banners, website headers |

---

## Shot Types & Angles

### From Above (Overhead)
```
"Shot from directly above looking straight down at approximately 45 degrees."
"Shot from directly above, everything flat and graphic."
```
*Best for:* flat lays, picnic shots, court shots, desk shots

### Low Angle
```
"Shot from slightly below at a low angle looking up, arm extended upward."
"Shot from knee height looking up."
```
*Best for:* hand holding bottle up, sky backgrounds, heroic product moments

### Eye Level
```
"Shot straight on at eye level with the bottle / glass / product."
"Shot straight on at counter level."
```
*Best for:* product shots, tapri shots, ingredient backgrounds

### POV / First Person
```
"Shot from the passenger's point of view looking down."
"Shot from the wearer's perspective looking at their lap."
```
*Best for:* local train shots, sitting shots, personal moments

### Mid-Body
```
"Shot from chest down — no face visible, frame cuts off at the collarbone."
"Frame cuts off at shoulder level — only hands, wrists and forearms visible."
```
*Best for:* lifestyle shots with people, no-face rule maintained

---

## Human Elements

### Skin Tones (Indian Market — Always Specify)
```
"Light wheatish skin tone, fair but warm undertone"          → North Indian, lighter skin
"Medium warm brown skin tone"                                 → General Indian
"Warm tanned brown skin, deep brown"                         → South Indian
"Light olive-yellow skin tone"                                → North East Indian
```

### Hands
```
"Fingers wrapped naturally around the bottle, casual grip"
"Fingers wrapped naturally around the base of the bottle from below"
"Hand resting naturally on or beside the product"
"One hand extending the bottle outward, other hand reaching in to receive it"
```

### Nails
```
"Clean nude nails"
"Bold dark nail colour"
"Bright pink or coral nail polish"
"Dark maroon nail polish"
```

### Jewellery
```
"A delicate gold bracelet on the wrist"
"Silver chain around neck, multiple silver rings"
"Simple gold ring on one finger"
"Chunky silver bracelet, chain-link style rings, styled like a streetwear enthusiast"
```

### Clothing — by Vibe

| Vibe | Clothing |
|---|---|
| Casual summer | White ribbed crop top, blue denim shorts, white Converse |
| Athletic | Black gym shorts, fitted black tee, white court sneakers |
| Pickleball | White pleated skirt, knit sweater, ribbed socks, court sneakers |
| Professional | Cream oversized blazer, white turtleneck, gold chain |
| Street | Oversized dark jacket, black outfit |
| Relaxed weekend | Mustard yellow wide-leg linen trousers, strappy sandals |

---

## No-Face Rules

Use these lines to remove faces from frame:

```
"No faces in frame at all — only hand, wrist, forearm visible."
"Frame cuts off at the collarbone — no face, no upper body above chest."
"Shot from directly above — no faces needed, body and product are the hero."
"No faces at all — frame cuts off at shoulder level."
"Frame cuts from nose to chest — face not fully shown."
```

---

## Product Accuracy Rules

### Always include all of these:

**Proportions:**
```
"330ml glass bottle approximately 22cm tall, notably slimmer and taller than a standard beer bottle"
"Standard 330ml glass bottle, standard proportions"
"Small concentrate bottle roughly 200ml, approximately 12 to 14cm tall"
```

**Label:**
```
"Label facing directly at camera, front and centre, completely readable"
"Label fully visible, facing up toward the camera, completely readable"
"The label is the sharpest, most readable element in the frame"
```

**Liquid:**
```
"[Colour] liquid clearly visible through the clear glass"
"Condensation droplets on the glass surface suggesting it is cold and fresh"
"Carbonation bubbles visible through the glass"
```

**Cap:**
```
"Silver crown cap at the top"
"Black screw cap"
"Cork cap"
```

---

## Background Treatments

### Flat Colour Backgrounds (Product Shots)
```
"Background is a solid flat [colour] — no gradient, no texture, no props"
"Background is a flat matte [colour] wall, completely minimal"
"Bold solid [colour] background, studio lighting, crisp edges"
```

### Split Backgrounds (Editorial)
```
"Background is split — upper two thirds is a flat matte [colour] wall, lower third is the white surface"
```

### Lifestyle Backgrounds
```
"Lush green grass filling the entire background"
"Vivid bright blue swimming pool water filling the background, shimmering light reflections"
"Green pickleball or tennis court surface and black net in background, slightly out of focus"
"Bright clear blue summer sky as the entire background, no clouds"
"Dense jungle or forest environment surrounding the bottle"
"Busy Mumbai street, urban chaos slightly out of focus behind"
```

### Natural / Ingredient Backgrounds
```
"The entire background and base is densely packed with [ingredient] — every inch covered, no gaps, no surface visible"
"Background is wall to wall ingredients, no gaps, no surface visible"
```

---

## Lighting Specifications

### Harsh Summer Sunlight (Most Used)
```
"Harsh bright midday sun casting sharp clean shadows"
"Strong outdoor daylight, high contrast, high saturation"
"Harsh bright summer sunlight, vivid and punchy colours"
```

### Golden Hour
```
"Warm golden hour light, soft amber tones"
"Early morning golden light, warm but not harsh"
```

### Soft Natural Light
```
"Soft natural daylight coming from slightly above and to the left, creating gentle shadows"
"Soft diffused natural daylight, no harsh shadows, everything feels calm and airy"
"Soft romantic natural daylight from slightly above and to the left"
```

### Studio / Editorial
```
"Bright harsh studio lighting, no soft shadows, everything sharp and in focus"
"Clean editorial food photography, no artificial lighting, no studio flash"
```

### Dappled / Outdoor Filtered
```
"Dappled natural sunlight filtering through trees above, warm and golden"
"Harsh warm sunlight creating sharp dappled shadows from trees above"
```

---

## Camera Style Lines

Always close with one of these before the product reference line:

```
"Hyper realistic photography, medium format camera feel, crisp and clean, no grain."
"Hyper realistic, film-like quality, slightly warm colour grade, muted tones."
"Shot on iPhone aesthetic, slightly editorial, film grain texture."
"Candid and real, feels like someone just grabbed this shot — not staged."
"High-end editorial food and beverage photography."
"Documentary street photography feel, film grain texture, slightly desaturated."
```

---

## Lifestyle Shot Templates

### Hand Holding Bottle Up (Sky Background)
```
"[Format]. A hand holding a [product] up toward the sky, shot from below at a sharp low angle, arm fully extended upward, bottle centred in frame. The hand is an Indian [woman's/man's] hand, [skin tone], natural grip around the base of the bottle, fingers wrapped naturally. The [product] is accurately proportioned — [dimensions]. Label facing directly at camera, fully readable, [liquid colour] liquid clearly visible through the clear glass. Background is [sky description]. [Lighting]. Hyper realistic photography, crisp and clean, no grain. Use the attached [product name] as exact product reference for bottle shape, label design, liquid colour, and proportions."
```

### Overhead Lifestyle (Court / Grass / Blanket)
```
"[Format]. Shot from directly above looking straight down at approximately 45 degrees. [Setting description]. [Person description — no faces]. Holding [product], label facing directly up toward camera, completely readable. [Clothing details]. [Props]. [Lighting]. Feels [mood]. Hyper realistic photography, medium format camera feel, crisp and clean. Use the attached [product name] as exact product reference."
```

### Product on Surface (Standalone)
```
"[Format]. [Product] standing upright, perfectly centred on a [surface]. Background is [description]. [Props if any]. [Lighting] creating [shadow description]. Nothing else in frame. Shot straight on at eye level with the [product]. Label fully visible and facing directly at camera, completely readable. [Camera style]. Use the attached [product name] as exact product reference."
```

### Ingredient Background (Synergy-style)
```
"[Format]. Hyper-realistic product photography. [Product] standing upright, perfectly centered in frame, shot straight on at eye level. The bottle is full scale, proportions completely accurate — [dimensions]. The entire background and base is densely packed with fresh [ingredient] — [accurate size description]. [Secondary ingredient] scattered naturally. No gaps in the ingredient bed — every inch of background covered. The bottle has natural condensation droplets. Label fully visible, facing directly at camera, completely readable. Lighting is soft natural daylight from slightly above and to the left. Shot on medium format camera, shallow depth of field, bottle tack sharp, ingredient background slightly softer but still detailed. Feels like high-end editorial food and beverage photography. Use [product] as exact product reference."
```

### Passing / Sharing Shot
```
"[Format]. Two Indian people [sharing/passing] a [product] [action description], both hands meeting in the centre of the frame — the bottle is the hero, centred and sharp. One hand [description], other hand [description]. No faces at all — frame cuts off at chest level. [Background / setting]. [Lighting]. [Camera style]. Use the attached [product name] as exact product reference."
```

---

## Common Mistakes to Avoid

| Mistake | Fix |
|---|---|
| Not specifying format | Always start with format — 4:5, 1:1, or 16:9 |
| Forgetting label direction | Always say "label facing directly at camera, completely readable" |
| Vague lighting | Be specific — "harsh midday", "golden hour", "soft diffused" |
| No skin tone | Always specify — light wheatish, medium brown, warm tanned |
| Forgetting condensation | Add "condensation droplets on the glass surface" for cold drink shots |
| Over-describing faces | Default to no faces — frame at shoulder/chest level |
| Wrong proportions | Always state ml volume AND approximate cm height |
| Not closing with reference line | Always end with "Use [product] as exact product reference" |
| Too many props | Keep props minimal — 2-3 max for lifestyle, 0 for product solo shots |
| Generic camera style | Always specify — medium format feel, film grain, or crisp and clean |

---

## Prompt Length Guide

| Shot Type | Ideal Prompt Length |
|---|---|
| Simple product solo | 150-200 words |
| Ingredient background | 200-250 words |
| Lifestyle with person | 250-350 words |
| Complex scene (multiple people, setting, props) | 300-400 words |

---

## Iterating on a Prompt

When a generated image needs adjustment, use these specific change phrases:

```
"Add condensation to the bottle"
"Make the label more readable / front facing"
"Change background colour to [colour]"
"Remove [element] from the frame"
"Adjust skin tone to [lighter/darker/warmer]"
"Shot from [higher/lower] angle"
"Make shadows [sharper/softer]"
"Increase/decrease saturation"
"The proportions of the bottle need to be [taller/slimmer/more accurate]"
```

---

## Product Reference Line Templates

Always close every prompt with one of these, adapted to the product:

```
"Use the attached [Brand] [Flavour/Product] bottle as exact product reference for bottle shape, label design, liquid colour, and proportions."

"Use the attached [Brand] [Product] image as exact product reference — do not show the bottle in frame, only the drink poured into the glass."

"Use [Brand] [Product] as the product reference image; replicate the screen contents faithfully including layout, typography, and colour scheme as shown in the reference."
```

---

## Category-Specific Notes

### Beverages
- Always specify liquid colour visible through glass
- Always add condensation for cold drink shots
- Specify cap type — crown cap, screw cap, cork
- For poured drinks: "do not show the bottle, only the drink poured into the glass"

### Food
- Specify the steam if hot ("steam very subtly rising")
- Describe texture in close-ups ("you can see the texture and the filling clearly")
- For drip/sauce shots: "mid-drip frozen in motion, glossy and thick"

### Fashion
- Specify fabric — ribbed, linen, cotton, knit
- Name the fit — fitted, oversized, relaxed
- Name the exact garment — pleated skirt, wide-leg trousers, crop top

### Skincare
- Clean surfaces — white marble, cream background
- Soft diffused lighting — never harsh for skincare
- Long clean shadows for editorial feel

### Tech
- "Replicate the screen contents faithfully using the attached reference"
- "No text anywhere except [specified elements]"
- "Overall colour palette: [specify]"
- "Feels calm, trustworthy, understated"

---

## Dos and Don'ts

### Do:
- Be specific about every visual element
- Describe what the image should feel like emotionally
- Name real-world objects accurately (court lines, crown cap, ribbed glass)
- State what is NOT in frame ("no faces", "no props", "no clutter")
- Use comparative references ("exactly like the reference image but [change]")

### Don't:
- Use vague words — "nice", "good", "professional", "aesthetic"
- Leave format unspecified
- Forget to anchor the product label direction
- Describe faces unless explicitly needed
- Stack too many props — keep it clean

---

*This guide is maintained by Linkrunner Media. Update after each new brand project to capture new prompt patterns.*
