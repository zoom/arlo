# Figma Design Prompt — Arlo Guest Mode Showcase

## Context

Arlo Meeting Assistant is a Zoom App that runs inside Zoom meetings. It captures live transcripts, generates AI summaries, and tracks action items — without a meeting bot. This design task adds **Guest Mode** — a read-only, real-time experience for meeting participants who haven't installed the app. An authenticated host invites guests during a meeting, and they get instant access to live transcripts and summaries with no sign-in required.

This is a **reference implementation** for Zoom developers. The guest mode should demonstrate best practices: the three-state user model (unauthenticated → authenticated → authorized), progressive elevation prompts, real-time collaboration, and seamless transitions when a guest decides to install.

---

## Design System

### Canvas & Layout
- **Viewport:** 390×844 (iPhone-sized panel — Zoom Apps render in a fixed sidebar). All designs at this size.
- **Max content width:** 600px, centered with `margin: 0 auto`.
- **Container:** White card region with 1px left/right borders (`#e5e5e5` light, `#262626` dark). Background outside borders: `#fafafa` light / `#0a0a0a` dark.
- **Padding:** 16px page padding. 20px internal card padding. 24px for CTA cards.
- **Spacing:** 24px between major sections. 16px between cards. 12px between tight groups.

### Typography
- **Headings & body text:** Source Serif 4 (serif), weight 400–500. Use for h1, h2, h3, meeting titles, transcript text, and descriptive paragraphs.
- **UI chrome:** Inter (sans-serif), weight 400–600. Use for buttons, labels, badges, timestamps, tab triggers, and metadata.
- **Monospace:** SF Mono. Use for timestamps only.
- **Scale:** 24px (h1), 20px (h2), 18px (h3), 16px (base), 14px (sm), 12px (xs).
- **Line heights:** 1.3 for headings, 1.5 for body, 1.6 for transcript text, 1.4 for small text.

### Colors

**Light mode:**
| Token | Hex | Usage |
|---|---|---|
| background | `#fafafa` | Page background |
| foreground | `#0a0a0a` | Primary text |
| card | `#ffffff` | Card backgrounds |
| muted | `#f5f5f5` | Secondary backgrounds, tab bar |
| muted-foreground | `#737373` | Secondary text, timestamps, descriptions |
| accent | `#2563eb` | Blue — buttons, links, badges, interactive elements |
| accent-foreground | `#ffffff` | Text on accent backgrounds |
| border | `#e5e5e5` | Card borders, dividers |
| destructive | `#dc2626` | Red — recording dot, stop button, errors |
| primary | `#0a0a0a` | Default button background |
| primary-foreground | `#fafafa` | Default button text |

**Dark mode:**
| Token | Hex | Usage |
|---|---|---|
| background | `#0a0a0a` | Page background |
| foreground | `#fafafa` | Primary text |
| card | `#171717` | Card backgrounds |
| muted | `#262626` | Secondary backgrounds |
| muted-foreground | `#a3a3a3` | Secondary text |
| accent | `#3b82f6` | Blue |
| border | `#262626` | Card borders |
| destructive | `#ef4444` | Red |

**Semantic colors:**
- Live badge: green `#22c55e` bg at 10% opacity, `#16a34a` text (light) / `#4ade80` text (dark), pulsing dot at full green.
- Paused badge: orange `#f97316` bg at 10% opacity, `#ea580c` text (light) / `#fb923c` text (dark).
- "Meeting ended" badge: muted foreground on muted background.
- Recording dot: `#ef4444` with ping animation.

### Components

**Card:** White background (`card`), 1px `border` stroke, border-radius 8px (`radius-lg`). No shadow.

**Button variants:**
- **Default:** `primary` bg, `primary-foreground` text. Height 36px, padding 0 16px, radius 6px, Inter 500 14px.
- **Accent:** `accent` bg, white text. Same dimensions.
- **Outline:** Transparent bg, `foreground` text, `border` stroke.
- **Ghost:** Transparent bg, `foreground` text, no border.
- **Large:** Height 44px, padding 0 24px, 16px text.
- **Small:** Height 32px, padding 0 12px, 13px text.

**Badge:** Pill shape (border-radius 9999px), padding 2px 8px, Inter 500 12px.
- Default: `muted` bg, `muted-foreground` text.
- Accent: `accent` bg, white text.
- Outline: transparent bg, `foreground` text, `border` stroke.

**Tab bar:** Muted background with 2px padding, border-radius 8px. Tabs fill equally. Selected tab: card background, foreground text, subtle shadow. Unselected: transparent, muted-foreground text. Inter 500 14px, padding 6px 12px.

**Live dot:** 8px green circle with a second 8px circle animating ping (scale 2, opacity 0). Use concentric circles to illustrate the pulse.

**Arlo owl icon:** Simple circle-based owl — large circle body, two white circles for eyes with small dark pupils, curved smile, two triangular ear tufts. Rendered in `foreground` color with `background` color for eye whites.

### Icons
Use Lucide icon style throughout: 24px default, 20px in cards, 16px in buttons, 14px inline. Stroke-based, 2px stroke width, round caps. Key icons used: Mic, Sparkles, Search, Pause, Play, Square, Users, Eye, Share2, Check, X, ChevronDown, ExternalLink, LogIn, LogOut, MicOff, Bookmark.

---

## Screens to Design

Design all screens in **both light and dark mode** (side by side frames).

---

### Screen 1: GuestNoMeetingView — Welcome (Unauthenticated)

**When shown:** An unauthenticated guest opens the app but is not currently in an active meeting (e.g., the meeting hasn't started yet, or this is the pre-meeting lobby).

**Layout (single-column, vertically centered):**

1. **Owl icon** — 64px, centered, foreground color.

2. **Invitation header** — Below owl, centered text:
   - "You've been invited to use Arlo" — Source Serif 4, 24px, weight 500, foreground.
   - "Your AI meeting assistant" — Inter, 14px, muted-foreground. 8px below heading.

3. **What is Arlo? paragraph** — Card with 20px padding. Source Serif 4, 14px, muted-foreground, line-height 1.7:
   > "Arlo captures live transcripts of your meeting, generates AI summaries, and tracks action items — all without a meeting bot. The meeting host has shared this app with you."

4. **Three feature cards** — Vertical stack, 12px gap. Each card has 16px internal padding, horizontal layout:
   - Left: Lucide icon in accent color (20px). Mic for Transcript, Sparkles for Summary, Bookmark for Highlights.
   - Right (flex column, 4px gap):
     - Title — Inter, 14px, weight 500, foreground. "Live Transcript" / "AI Summary" / "Highlights"
     - Description — Inter, 14px, muted-foreground. Guest-specific phrasing:
       - "Follow along with a real-time transcript. See who said what, with timestamps."
       - "Key takeaways, decisions, and action items — generated as the meeting progresses."
       - "View moments the host has bookmarked as important."

5. **Guest vs. Full comparison** — Small card or subtle section. Table-like layout with three columns. Inter 12px for header row (muted-foreground, weight 500), Inter 13px for content rows. Use check marks (accent) and dashes (muted-foreground) instead of words:

   | Feature | Guest | Full |
   |---|---|---|
   | Live transcript | ✓ Read-only | ✓ Full controls |
   | AI summary | ✓ View | ✓ Generate & edit |
   | Highlights | ✓ View | ✓ Create & manage |
   | Meeting history | Current only | All meetings |
   | Search | — | ✓ Full-text |

6. **CTA buttons** — Full-width, 16px gap between them:
   - Primary: "Sign in to Zoom" — accent variant, large (44px). Includes LogIn icon (16px) on right.
   - Secondary: "Continue as guest" — ghost variant, default size (36px). Muted-foreground text. Inter 14px.

**Total max width:** 400px, centered in the viewport.

---

### Screen 2: GuestNoMeetingView — Welcome (Authenticated)

**Identical to Screen 1** except:
- Primary CTA button text changes to: "Add Arlo to Your Account" (still accent variant, large).
- Secondary CTA unchanged: "Continue as guest."
- Small subtle text below the primary button: "You're signed in to Zoom. Add the app for full access." — Inter 12px, muted-foreground, centered.

---

### Screen 3: GuestNoMeetingView — Waiting for Meeting

**Same as Screen 1** but with an additional element at the very top:
- **Waiting banner** — Full-width card at top, 12px padding. Horizontal layout:
  - Left: LoadingSpinner (16px, muted-foreground, subtle animation).
  - Right: "Waiting for the meeting to start..." — Inter, 14px, muted-foreground.
- Rest of content remains the same.

---

### Screen 4: GuestInMeetingView — Live Meeting (Primary View)

**When shown:** An unauthenticated guest has the app open during an active meeting. This is the flagship screen. It should feel alive and real-time.

**Layout (full-height, no scroll on outer page — transcript scrolls internally):**

1. **Compact header** (sticky top, card background, 1px bottom border, 12px 16px padding):
   - Left: Arlo owl icon (20px) + "Arlo" text — Inter 14px weight 600.
   - Center: Meeting title — Source Serif 4, 16px, weight 500, truncated with ellipsis if long. Max-width ~200px.
   - Right: Live badge — same green style as existing (green dot + "Live" text in green pill).

2. **Live transcript area** (takes remaining height minus header, summary, and bottom bar):
   - Card with no top border-radius (flush with header).
   - Internal scrollable area, 20px padding.
   - **Transcript segments** — identical styling to the authenticated InMeetingView:
     - Each segment: timestamp (SF Mono, 12px, muted-foreground, flex-shrink 0) + speaker name (Inter, 14px, weight 500, foreground) on one line, 12px gap between them.
     - Transcript text below, indented 64px from left. Source Serif 4, 14px, foreground, line-height 1.6.
     - 16px margin between segments.
   - **Participant events inline** — "Alice joined the meeting" with left border accent (2px solid border-color), small icon (14px, muted-foreground), Inter 13px muted-foreground text, timestamp on right.
   - **Scroll-to-live button** — When user scrolls up: floating pill button at bottom center of transcript area. "Scroll to live" with down-arrow icon. Small default button with subtle box-shadow.
   - **Show realistic sample content** — at least 8-10 transcript segments from different speakers (Alice, Bob, Charlie) discussing a project. Include 1-2 inline participant events ("Charlie joined the meeting").

3. **Collapsible summary card** (below transcript, above bottom bar):
   - **Collapsed state (default):** Card with horizontal layout, 12px padding:
     - Left: Sparkles icon (16px, accent).
     - Center: "Meeting Summary" — Inter, 14px, weight 500.
     - Right: ChevronDown icon (16px, muted-foreground).
   - **Expanded state (show as a variant):** Same header but ChevronDown rotated to ChevronUp. Below header, 1px top border divider, then 16px padding:
     - "Overview" heading — Inter, 12px, weight 600, muted-foreground, uppercase, letter-spacing 0.5px.
     - Summary text — Source Serif 4, 14px, foreground, line-height 1.7. 2-3 sentences.
     - "Action Items" heading — same style as Overview.
     - Bulleted list, each item: Inter 14px, foreground. Bullet is accent-colored circle (6px).

4. **Presence indicator** (subtle bar between summary and bottom CTA):
   - Horizontal layout, 8px padding:
     - Left: Eye icon (14px, muted-foreground).
     - "3 people viewing" — Inter, 12px, muted-foreground.
     - Right: Three overlapping avatar circles (24px each, -8px margin-left overlap). Each circle: colored background (use 3 distinct muted colors like `#dbeafe`, `#fce7f3`, `#dcfce7`), Inter 11px weight 600 white text with first initial ("A", "B", "C").

5. **Sticky bottom CTA bar** (card background, 1px top border, 12px 16px padding):
   - Left: "Want to capture your own meetings?" — Inter, 13px, foreground.
   - Right: "Install Arlo" button — accent variant, small (32px).
   - Far right: X button (ghost, icon size, 14px X icon, muted-foreground) to dismiss.

---

### Screen 5: GuestInMeetingView — Live Meeting (Authenticated State)

**Identical to Screen 4** except:
- Bottom CTA bar text changes to: "Add Arlo for full meeting controls"
- Button text changes to: "Add Arlo"
- Add subtle text below the CTA bar (inside the bar, smaller): "You're signed in — adding takes 10 seconds" — Inter, 11px, muted-foreground.

---

### Screen 6: GuestInMeetingView — Summary Expanded

**Same as Screen 4** but with the summary card in its expanded state. The transcript area shrinks proportionally to make room. Show realistic summary content:

- **Overview:** "The team discussed the Q1 product roadmap, focusing on the mobile app launch timeline and resource allocation. Key concern raised about testing bandwidth in March."
- **Key Decisions:**
  - "Push mobile beta to March 15 (was March 1)"
  - "Hire contract QA engineer for 6-week engagement"
- **Action Items:**
  - "Alice: Draft revised timeline by Friday"
  - "Bob: Post QA job listing by EOD"
  - "Charlie: Schedule follow-up with design team"

---

### Screen 7: GuestInMeetingView — Contextual Elevation Prompts

**Three variant states** showing inline prompts (not modals). Each is a subtle inline card that appears at a natural interaction point:

**Variant A — Ask a question prompt:**
- Below the expanded summary card, a placeholder input area with a lock icon:
  - Faded input field: "Ask a follow-up question..." — Inter 14px, muted-foreground, with Lock icon (14px) on left.
  - Below input: "Sign in to ask Arlo questions about this meeting." — Inter, 12px, accent color. Tap target (functions as a link).

**Variant B — Search prompt (shown when scrolling to top):**
- At the very top of the transcript area, a subtle banner:
  - Card background with accent-tinted left border (3px solid accent).
  - Search icon (16px, accent) + "Install Arlo to search across all your meetings." — Inter 13px, foreground. Right side: small accent "Install" link text.

**Variant C — Meeting ended transition prompt:**
- Separate card replacing the live transcript when meeting ends:
  - "Meeting ended" badge (muted variant) centered at top.
  - Below: "This meeting's transcript is saved. Install Arlo to access it anytime." — Source Serif 4, 16px, weight 500, centered.
  - Below: Two buttons centered. Primary: "Install Arlo" (accent, large). Secondary: "Learn more" (outline, default) with ExternalLink icon.

---

### Screen 8: GuestInMeetingView — Meeting Ended

**When shown:** The meeting has ended. The guest view transitions from live streaming to a static summary.

**Layout:**

1. **Header** (same compact header as Screen 4, but):
   - Live badge replaced with "Ended" badge — muted variant (gray pill, no dot).
   - Arlo owl icon + "Arlo" text remains.
   - Meeting title remains.

2. **Final summary card** (prominent, card with 20px padding):
   - Meeting title — Source Serif 4, 20px, weight 500.
   - Date/time — Inter, 14px, muted-foreground. "Monday, February 16, 2026 · 45 minutes"
   - Horizontal divider (1px border color), 16px vertical margin.
   - **Overview section** — heading + paragraph (same styling as Screen 6 expanded summary).
   - **Key Decisions section** — heading + bulleted list.
   - **Action Items section** — heading + bulleted list with assignee names.
   - **Topics Discussed** — heading + inline pill badges (outline variant): "Q1 Roadmap", "Mobile App", "QA Hiring", "Timeline".

3. **Full transcript** (scrollable card, no fade overlay, no truncation):
   - Same segment styling as Screen 4 but at full opacity, full length (show all segments).
   - No "Sign in to see full transcript" pill — the meeting is over, content is freely available.

4. **Install CTA card** (accent-tinted card: `accent` at 5% opacity mixed with card bg, accent border):
   - 24px padding.
   - Heading: "Capture every meeting" — Source Serif 4, 18px, weight 500.
   - Body: "Install Arlo to get transcripts and summaries for all your Zoom meetings — automatically." — Inter, 14px, muted-foreground, line-height 1.6.
   - Buttons (16px gap):
     - Primary: "Install Arlo" — accent variant, large.
     - Secondary: "Learn more" — outline variant, default. ExternalLink icon (16px).

---

### Screen 9: Host InMeetingView — Invite Controls

**This is the authenticated host's view** (existing InMeetingView design with additions). Show the existing transport controls bar with new invite elements.

**Transport controls bar** (existing card, horizontal layout):
- Left side (existing): Recording dot (red, pulsing) + "Transcribing" label.
- Center/right (existing): Pause button (outline, small) + Stop button (destructive outline, small).
- **New — far right:** Share2 icon button (ghost variant, icon size 32px, accent color). Tooltip: "Share with meeting".

**When share button is tapped — show a dropdown/popover:**
- Card with subtle shadow (0 4px 12px rgba(0,0,0,0.1)), positioned below the share button.
- Two options, vertical stack:
  - **"Invite all participants"** — Users icon (16px) + text, Inter 14px. Full-width tap target with 12px padding. Hover: muted background.
  - **"Choose participants..."** — Users icon (16px) + text, Inter 14px. Same styling. Subtle divider between the two options.

**After inviting — confirmation state:**
- Share2 icon button temporarily changes to Check icon in green (`#16a34a`) for 3 seconds, then reverts.
- Toast notification at bottom: Card with green-tinted left border, Check icon (green), "App invitation sent to participants." — Inter 14px.

---

### Screen 10: Host InMeetingView — Guest Viewer Count

**Same host InMeetingView** but showing the presence indicator:

**In the transport controls bar** (between status and buttons):
- Eye icon (14px, muted-foreground) + "3 viewing" — Inter, 12px, muted-foreground. Subtle, doesn't compete with controls.

**Expanded state (tapping the viewer count):**
- Small popover card below the count:
  - List of viewer names, vertical stack:
    - Each row: Colored initial circle (20px) + Name — Inter 13px. + Badge: "Guest" (outline variant, 10px text) or "Host" (accent variant, 10px text).
  - Example content: "Alice (You)" [Host badge], "Bob" [Guest badge], "Jill" [Guest badge].

---

### Screen 11: Host InMeetingView — Share Reminder

**Same host InMeetingView** but with a dismissible prompt. Show this after 2 minutes if the host hasn't invited anyone.

**Share reminder banner** (positioned between header and tabs):
- Card with accent-tinted background (accent at 5% mixed with card). 12px padding. Horizontal layout:
  - Left: Users icon (16px, accent).
  - Center: "Share Arlo with this meeting's participants so they can follow along." — Inter, 13px, foreground.
  - Right: Two elements:
    - "Invite All" — small accent button (32px height).
    - X dismiss button — ghost, icon size, muted-foreground.

---

### Screen 12: GuestInMeetingView — Bottom CTA Dismissed

**Same as Screen 4** but with the bottom CTA bar removed (user tapped X). The transcript area expands to fill the freed space. Presence indicator still visible at the bottom. This shows the clean, non-intrusive experience after dismissal.

---

## Component Library (Atoms)

Create these as reusable Figma components with variants:

1. **Live Badge** — Variants: Live (green dot + "Live"), Ended (gray, no dot), Paused (orange, no dot).
2. **Guest CTA Bar** — Variants: Unauthenticated ("Install Arlo"), Authenticated ("Add Arlo"), Dismissed (hidden).
3. **Presence Indicator** — Variants: Compact ("3 viewing"), Expanded (name list popover).
4. **Elevation Prompt** — Variants: Ask Question, Search, Meeting Ended.
5. **Transcript Segment** — Variants: Speech (speaker + text), Participant Event (join/leave inline).
6. **Summary Card** — Variants: Collapsed, Expanded, Skeleton (loading).
7. **Share Button** — Variants: Default (Share2 icon), Sent (Check icon, green), With Popover.
8. **Share Reminder Banner** — Accent-tinted card with invite action.
9. **Viewer Count** — Variants: Compact (inline), Expanded (popover with names).
10. **Feature Card** — Icon + title + description, horizontal layout. Used in GuestNoMeetingView.
11. **Comparison Table** — Guest vs Full access, with check/dash indicators.

---

## Flow Diagram

Create a simple flow diagram showing the guest user journey:

```
Guest receives invitation in Zoom
       ↓
Opens app → GuestNoMeetingView (if no active meeting)
       ↓                    OR
Opens app → GuestInMeetingView (if in active meeting)
       ↓
Views live transcript + summary (read-only)
       ↓
Sees contextual elevation prompts
       ↓
  ┌─── Taps "Install" / "Sign In" ───┐
  ↓                                    ↓
promptAuthorize()               Continues as guest
  ↓                                    ↓
Status changes to authorized     Meeting ends
  ↓                                    ↓
Seamless transition to           Post-meeting summary
authenticated InMeetingView      + prominent install CTA
(gains controls, same transcript)
```

---

## Design Notes

- **No aggressive modals or popups.** All elevation prompts are inline and contextual. The guest experience should feel complete and valuable on its own — the upgrade prompts are gentle nudges, not gates.
- **The transcript should feel identical to the authenticated version** — same typography, same spacing, same speaker colors. The only visible difference is the absence of transport controls and the presence of the bottom CTA bar.
- **Dark mode is important** — many users use Zoom in dark mode. Ensure all screens work in both themes.
- **The Arlo owl icon is the only branding element.** No logos, no wordmarks. The owl appears in the guest header and the welcome screen.
- **Animation hints:** Show the live dot pulse, the scroll-to-live button's box-shadow, and the summary card's expand/collapse chevron rotation as static variants (before/after frames) rather than trying to animate in Figma.
- **Content should feel real.** Use realistic meeting transcript content, not lorem ipsum. Name the participants Alice, Bob, and Charlie. The meeting topic is "Q1 Product Roadmap Review."
