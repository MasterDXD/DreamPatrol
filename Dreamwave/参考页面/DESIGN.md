---
name: Night Serenity
colors:
  surface: '#051424'
  surface-dim: '#051424'
  surface-bright: '#2c3a4c'
  surface-container-lowest: '#010f1f'
  surface-container-low: '#0d1c2d'
  surface-container: '#122131'
  surface-container-high: '#1c2b3c'
  surface-container-highest: '#273647'
  on-surface: '#d4e4fa'
  on-surface-variant: '#c6c6cd'
  inverse-surface: '#d4e4fa'
  inverse-on-surface: '#233143'
  outline: '#909097'
  outline-variant: '#45464d'
  surface-tint: '#bec6e0'
  primary: '#bec6e0'
  on-primary: '#283044'
  primary-container: '#0f172a'
  on-primary-container: '#798098'
  inverse-primary: '#565e74'
  secondary: '#d0bcff'
  on-secondary: '#3c0091'
  secondary-container: '#571bc1'
  on-secondary-container: '#c4abff'
  tertiary: '#4cd7f6'
  on-tertiary: '#003640'
  tertiary-container: '#001b21'
  on-tertiary-container: '#008da5'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#e9ddff'
  secondary-fixed-dim: '#d0bcff'
  on-secondary-fixed: '#23005c'
  on-secondary-fixed-variant: '#5516be'
  tertiary-fixed: '#acedff'
  tertiary-fixed-dim: '#4cd7f6'
  on-tertiary-fixed: '#001f26'
  on-tertiary-fixed-variant: '#004e5c'
  background: '#051424'
  on-background: '#d4e4fa'
  surface-variant: '#273647'
typography:
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 40px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1'
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-margin: 24px
  gutter: 16px
  stack-sm: 12px
  stack-md: 24px
  stack-lg: 48px
---

## Brand & Style
The brand personality is ethereal, introspective, and restorative. Designed for a dream journal application, the design system facilitates a transition from the waking world to the subconscious. The target audience seeks a private, safe space to record reflections, requiring an interface that feels both expansive like the night sky and intimate like a personal diary.

The design style is **Glassmorphism with Skeuomorphic accents**. It utilizes translucent layers to mimic the fluid nature of dreams, while subtle physical metaphors (soft depth, realistic lighting, and tactile button surfaces) provide a sense of groundedness. The UI is punctuated by dream-like imagery—nebulae and fireflies—to create a sense of wonder and calm.

## Colors
The palette is rooted in the depth of the night. **Deep Indigo** serves as the primary canvas, providing a low-stimulation environment that reduces eye strain during late-night or early-morning entry.

**Secondary Soft Purple** and **Tertiary Teal** act as the primary interactive drivers, used for calls to action and highlighting active states. These colors are applied with subtle outer glows to mimic celestial bodies. 

The **Emotion Palette** allows users to categorize dreams by mood:
- **Calm:** Deep sky blues.
- **Vibrant:** Warm, muted yellows.
- **Soft Reds:** Desaturated corals for intense dreams.
- **Mystical:** Vivid purples for lucid or surreal experiences.

All text combinations are tested against primary backgrounds to ensure WCAG AA compliance, primarily utilizing light silver and cool grays for secondary information.

## Typography
The typography system balances modern legibility with a soft, welcoming tone. **Plus Jakarta Sans** is used for headlines; its rounded terminals and friendly proportions prevent the dark interface from feeling too cold or "high-tech." 

For long-form journal entries, **Inter** provides a highly legible, neutral experience that stays out of the way of the user's thoughts. **Geist** is reserved for technical labels, timestamps, and metadata, providing a precise, monospaced-adjacent feel that contrasts beautifully with the organic shapes of the UI.

Hierarchy is maintained through generous line heights (1.6 for body text) to ensure the journal entries feel airy and unhurried.

## Layout & Spacing
This design system utilizes a **fluid grid** with an 8px base unit. Layouts should feel centered and focused, reflecting the solitary nature of dreaming. 

On mobile, a single-column layout is preferred with 24px side margins to provide "breathing room" against the screen edges. For larger screens, content is constrained to a max-width of 800px for journal entries to maintain optimal line lengths. 

Spacing is intentionally generous (Stack-LG) between major sections to prevent visual clutter and maintain the "Serenity" aspect of the brand.

## Elevation & Depth
Depth is created through **Glassmorphism and light-based hierarchy**. Instead of traditional black shadows, elements use:
1.  **Backdrop Blurs:** 12px to 20px blur on container surfaces.
2.  **Translucent Borders:** 1px solid white borders at 10-15% opacity to define edges against the dark background.
3.  **Inner Glows:** Subtle top-down inner highlights (1px white at 20% opacity) to simulate a soft "moonlight" hitting the top edge of elements.
4.  **Floating Elements:** Interactive elements like the IP nebula character or floating action buttons use a soft, colored outer glow (diffused 30px) matching their brand color rather than a shadow.

## Shapes
The shape language is organic and soft. Standard containers use a **0.5rem (8px)** radius, while journal cards and major UI surfaces use **1rem (16px)** to feel more approachable. 

Interactive elements like tags, mood selectors, and primary buttons use **Pill-shapes** (full rounding) to mimic the smoothness of river stones or celestial bodies. Sharp corners are strictly avoided to maintain the "Soft" and "Fluid" emotional response.

## Components
### Buttons
Buttons feature a soft gradient (Soft Purple to Teal) with a 1px glass-like stroke. On hover/active states, the button should exhibit a "squishy" skeuomorphic press effect, scaling down to 98% with an increased outer glow.

### Cards (Journal Entries)
Cards utilize the Glassmorphism style. Backgrounds are primary-indigo at 40% opacity with a 16px background blur. This allows the background nebulae/star imagery to peek through the UI, creating a sense of depth.

### Chips & Tags
Used for dream symbols or emotions. These are semi-transparent pills with a subtle color-tinted border matching the mood (e.g., a "Calm" dream tag has a soft blue border).

### Input Fields
Inputs are "sunken" skeuomorphic wells. They use a darker shade than the primary background with an inner shadow to create an inset look, implying a space where the user can "drop" their thoughts.

### Linear Icons
Icons are drawn with a 1.5pt stroke and rounded caps. Where possible, icons should incorporate "celestial" dots or breaks in the lines to feel lighter and more ethereal.

### IP Character (The Nebula)
The nebula character should appear in empty states and during transitions. It is a non-constrained, organic shape with a heavy blur and animated "pulsing" opacity to feel like it is breathing.