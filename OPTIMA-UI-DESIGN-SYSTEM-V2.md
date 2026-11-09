# Optima — UI Design System V2
## Shared geometry with service themes

**Status:** canonical visual system for the Optima application\
**Scope:** Image Optimizer, HTML Content Editor, shared shell, drawers, dialogs and future Optima tools\
**Reference direction:** attached LABLY interface references supplied by the user\
**Version:** 2.0

---

# 1. Visual direction

Optima V2 replaces Optimizer lime/yellow with green while preserving the confirmed blue/indigo Editor identity.

The Optimizer theme uses the following visual language; Editor colors are defined separately in sections 2, 20 and 33:

- soft sage and eucalyptus greens;
- deep natural green accents;
- pale mint backgrounds;
- large white surfaces;
- gentle green gradients;
- very soft borders;
- black / charcoal typography;
- restrained shadows;
- occasional warm peach only for warnings;
- generous empty space;
- rounded, calm product UI.

The interface should feel:

**clean · premium · calm · modern · professional · light**

It must not feel:

- neon;
- yellow-green;
- muddy olive;
- generic SaaS template styling;
- dashboard-template-like;
- heavily bordered;
- over-carded;
- glossy or futuristic;
- excessively glassmorphic.

The references use green as an atmosphere, not as decoration on every control.\
White space remains the main visual material.

---

# 2. Shared system, separate service themes

Image Optimizer and HTML Content Editor share Onest typography, spacing, radius,
shadows, control geometry, motion and accessibility. Shared V2 improvements remain.

## Theme A - Image Optimizer

- pale mint backgrounds;
- botanical green accents and gradients;
- peach warnings;
- white cards.

## Theme B - HTML Content Editor

- cool gray / blue-neutral backgrounds;
- confirmed blue / indigo accents;
- flat soft blue selection and blue focus;
- solid blue primary actions;
- white working surfaces.

`[data-ui-theme="optima"]` uses the root Optimizer palette.
`[data-ui-theme="editor"]` overrides semantic colors only (section 33).
Green gradient tokens belong to Optimizer; Editor does not consume them.
Do not introduce a purple gradient or restore old cyan #238FBC.

Palette and gradient sections 3-6 describe Optimizer colors unless stated otherwise.
Shared layout, geometry and accessibility rules apply to both services.

---

# 3. Core palette

## 3.1 Neutral / surface colors

```css
--ui-bg-app: #EFF4F0;
--ui-bg-workspace: #E5EEE7;

--ui-surface-1: #FFFFFF;
--ui-surface-2: #F8FAF8;
--ui-surface-3: #F1F5F2;
--ui-surface-soft-green: #E8F1E9;

--ui-text-primary: #151A16;
--ui-text-secondary: #626B64;
--ui-text-muted: #8B948D;
--ui-text-disabled: #AEB6B0;

--ui-border-soft: #E5EAE6;
--ui-border: #D8E0DA;
--ui-border-strong: #C5D1C7;
```

White must remain dominant.

The pale green background should appear mainly:

- around the application;
- in workspace areas;
- behind large panels;
- in empty states;
- in soft selected states.

Do not fill every card green.

---

## 3.2 Brand green scale

```css
--ui-green-950: #234B2C;
--ui-green-900: #2E6037;
--ui-green-800: #356C3E;
--ui-green-700: #3F7847;
--ui-green-600: #4C8254;
--ui-green-500: #5D9164;
--ui-green-400: #74A37A;
--ui-green-300: #9DC0A1;
--ui-green-200: #C8DCCA;
--ui-green-100: #E4EFE5;
--ui-green-50: #F3F8F4;
```

Primary accent:

```css
--ui-accent: #3F7847;
--ui-accent-hover: #356C3E;
--ui-accent-active: #2E6037;
--ui-accent-soft: #E4EFE5;
--ui-accent-soft-strong: #D8E8DA;
--ui-accent-border: #9DBDA1;
--ui-accent-ink: #234B2C;
--ui-text-on-accent: #FFFFFF;
--ui-focus-ring: rgb(63 120 71 / 24%);
```

The important change compared with V1:

**no fluorescent lime.**

Green should feel botanical and slightly muted.

---

# 4. Gradient language

Gradients are a major part of Optima V2, but they must be controlled.

The references use broad, low-noise tonal transitions rather than bright multi-color gradients.

## 4.1 Main brand gradient

Use for:

- primary CTA;
- large active feature surface;
- selected hero/feature panel;
- instruction drawer accent header;
- important branded state.

```css
--ui-gradient-brand:
  linear-gradient(
    135deg,
    #356C3E 0%,
    #3F7847 42%,
    #4C8254 100%
  );
```

White text is allowed on this gradient.

Do not lighten the end of the primary CTA gradient beyond a level where white text loses contrast.

---

## 4.2 Large atmospheric green gradient

Use only for decorative or large non-text-critical areas.

```css
--ui-gradient-atmosphere:
  linear-gradient(
    135deg,
    #4B8052 0%,
    #5D9164 48%,
    #76A47A 100%
  );
```

This is the closest Optima interpretation of the broad green areas in the references.

If important text is placed on it, add a darker local layer or use a darker gradient token.

---

## 4.3 Soft mint gradient

For:

- selected cards;
- active service blocks;
- soft onboarding;
- helper surfaces;
- subtle highlighted sections.

```css
--ui-gradient-soft:
  linear-gradient(
    135deg,
    #F7FAF7 0%,
    #E7F0E8 100%
  );
```

---

## 4.4 Workspace background gradient

The overall application may use a very subtle large-scale gradient rather than a flat beige/gray background.

```css
--ui-gradient-app:
  radial-gradient(
    circle at 18% 12%,
    rgb(255 255 255 / 78%) 0%,
    rgb(255 255 255 / 0%) 36%
  ),
  linear-gradient(
    135deg,
    #E8F1EA 0%,
    #F3F6F3 52%,
    #DDEADF 100%
  );
```

The gradient must remain quiet enough that white panels are still clearly readable.

---

## 4.5 Glass / translucent green surface

Use sparingly for overlays, large feature panels or drawers.

```css
--ui-gradient-glass:
  linear-gradient(
    135deg,
    rgb(255 255 255 / 16%) 0%,
    rgb(255 255 255 / 7%) 100%
  );
```

Optional:

```css
backdrop-filter: blur(14px);
```

Never use glass effects inside user Preview content.

---

# 5. Gradient rules

## Do

Use gradients on:

- one main CTA;
- one large branded panel;
- instruction / feature drawer header;
- occasional selected feature area;
- page/workspace background;
- progress or success visualization where appropriate.

## Do not

Do not use gradients on:

- every small button;
- every input;
- every list row;
- every result card;
- destructive controls;
- body text backgrounds;
- crop handles;
- HTML user Preview.

A page should usually have **one dominant gradient treatment and several very soft secondary ones**, not dozens of competing gradients.

---

# 6. Semantic status palette

The references include very restrained warm and alert tones.

## Success

```css
--ui-success: #3F7847;
--ui-success-soft: #E7F1E8;
--ui-success-border: #B9D0BC;
```

## Information

Prefer neutral mint rather than blue.

```css
--ui-info: #567B5D;
--ui-info-soft: #EDF4EE;
--ui-info-border: #CADACD;
```

## Warning

Replace the old yellow UI language with a warm peach.

```css
--ui-warning: #A76B46;
--ui-warning-soft: #FFF1E8;
--ui-warning-border: #EAC7AF;
```

## Danger

```css
--ui-danger: #C85E57;
--ui-danger-hover: #B64F49;
--ui-danger-soft: #FCECE9;
--ui-danger-border: #E8B6B1;
```

## Special technical guide

Crop smart guides are a deliberate exception:

```css
--ui-crop-guide: #F04444;
```

Exactly:

- 1 visual px;
- no halo;
- no shadow;
- visible only during snap;
- never recolor to green.

---

# 7. Typography

Primary UI font:

**Onest**

```css
--ui-font-family:
  var(--font-onest),
  "Onest",
  system-ui,
  -apple-system,
  "Segoe UI",
  sans-serif;
```

Weights:

```text
400 — body, descriptions
500 — controls, labels, navigation
600 — headings, active states, important actions
```

Avoid:

- 800;
- 900;
- aggressive uppercase everywhere.

Uppercase is acceptable only for compact utility labels where already established.

Minimum visible UI size:

**12px**

Preferred:

```text
12px — metadata
13px — compact controls
14px — normal controls / labels
15–16px — body
18–22px — section headings
28–40px — page titles depending on viewport
```

---

# 8. Radius system

The references are softer and more rounded than Optima V1.

```css
--ui-radius-xs: 6px;
--ui-radius-sm: 9px;
--ui-radius-md: 12px;
--ui-radius-lg: 16px;
--ui-radius-xl: 20px;
--ui-radius-pill: 999px;
```

Usage:

- inputs: 9–12px;
- buttons: 10–12px;
- cards: 14–16px;
- large panels/drawers: 16–20px;
- statuses: pill only where semantically useful.

Do not make every rectangular element a pill.

---

# 9. Border system

Borders should almost disappear.

```css
--ui-border-width: 1px;
```

Default:

```css
border: 1px solid var(--ui-border-soft);
```

Strong border only for:

- selected state;
- focused state;
- meaningful separation.

Selected cards should not combine:

- strong fill;
- strong border;
- inner stroke;
- shadow

all at once.

One clear signal is enough.

---

# 10. Shadows

The references use broad but very soft depth.

```css
--ui-shadow-xs:
  0 2px 8px rgb(32 63 37 / 5%);

--ui-shadow-sm:
  0 8px 24px rgb(32 63 37 / 7%);

--ui-shadow-md:
  0 16px 40px rgb(32 63 37 / 10%);

--ui-shadow-lg:
  0 28px 72px rgb(32 63 37 / 12%);
```

Usage:

- ordinary card: none or xs;
- floating toolbar: xs/sm;
- drawer: md;
- modal: md;
- major visual presentation only: lg.

No dense black shadows.

---

# 11. Page background

The old warm beige Optima background is removed.

Optimizer default:

```css
background:
  var(--ui-gradient-app);
```

Optimizer feels pale mint / white. Editor page and shell use flat `var(--ui-bg-app)` from its cool palette.

Large working areas may use:

```css
background: var(--ui-bg-workspace);
```

Panels stay white.

---

# 12. Application shell

The shell should feel like a light product frame.

Navigation:

- white / translucent white surface;
- active indicator using the current service accent;
- very soft border;
- no yellow;
- Editor uses blue / indigo;
- no strong filled tab unless needed.

Active Optimizer service (Editor uses `var(--ui-accent-soft)` instead of the gradient):

```css
background: var(--ui-gradient-soft);
border-color: var(--ui-accent-border);
color: var(--ui-accent-ink);
```

Small active dot:

```css
background: var(--ui-accent);
```

Hover:

```css
background: var(--ui-surface-3);
```

---

# 13. Primary actions

Primary CTA uses the dark brand gradient.

```css
background: var(--ui-gradient-brand);
color: var(--ui-text-on-accent);
border: 0;
box-shadow: var(--ui-shadow-xs);
```

Hover:

- slightly darker;
- never brighter neon.

Active:

- deeper green;
- no scale jump.

Primary CTA must look strong but calm.

Examples:

- Optimize;
- Copy changed code;
- Confirm important action.

---

# 14. Secondary buttons

```css
background: var(--ui-surface-1);
color: var(--ui-text-primary);
border: 1px solid var(--ui-border);
```

Hover:

```css
background: var(--ui-surface-3);
border-color: var(--ui-border-strong);
```

No tinted green text unless the action is selected.

---

# 15. Ghost / icon buttons

Default:

- transparent;
- dark muted icon;
- quiet hover surface.

Selected:

```css
background: var(--ui-accent-soft);
color: var(--ui-accent-ink);
```

Destructive icon:

- neutral at rest;
- red only on hover/focus/confirmation.

---

# 16. Inputs

```css
background: #FFFFFF;
border: 1px solid var(--ui-border);
border-radius: var(--ui-radius-sm);
color: var(--ui-text-primary);
```

Focus:

```css
border-color: var(--ui-accent);
box-shadow: 0 0 0 3px var(--ui-focus-ring);
```

No green fill in normal text inputs.

---

# 17. Selected cards

The new selected state should be subtle.

Preferred:

```css
background: var(--ui-gradient-soft);
border-color: var(--ui-accent-border);
color: var(--ui-text-primary);
```

Optional small indicator:

```css
color: var(--ui-accent);
```

Do not use:

- lime fill;
- yellow fill;
- thick olive border;
- inner stroke;
- large shadow.

---

# 18. Large feature / help panels

The references use green as a large contextual surface.

For important branded panels:

```css
background: var(--ui-gradient-brand);
color: #FFFFFF;
```

Inside such a panel, nested cards should become:

```css
background: rgb(255 255 255 / 12%);
border: 1px solid rgb(255 255 255 / 12%);
```

or fully white cards where stronger contrast is needed.

This approach is suitable for:

- instruction drawer hero;
- future AI/service summary;
- onboarding;
- success/summary panel.

Do not apply it to the whole working form.

---

# 19. Image Optimizer

The Optimizer must lose the old lime/yellow look completely.

## Page

- pale mint gradient around content;
- white working container;
- dark charcoal text;
- botanical green accent.

## Mode cards

Default:

- white;
- soft border.

Selected:

- soft mint gradient;
- sage border;
- dark text;
- optional green icon/dot.

## Crop

Keep functional hierarchy.

Frame/handles:

- dark green / white;
- not lime.

Grid:

- neutral white / translucent.

Smart guides:

- red `#F04444`;
- unchanged.

## Ratio / size / quality

Use the same selected-card language.

No yellow info bar.

## Help

Help uses:

- white or pale mint;
- optionally a thin green-tinted border.

Warnings use peach, not yellow.

## Primary Optimize CTA

Use `--ui-gradient-brand`.

White text.

No separate icon compartment.

No uppercase tracking unless typography genuinely requires it.

## Results

- white rows;
- subtle borders;
- soft mint selected row;
- green check/status;
- no lime surfaces.

---

# 20. HTML Content Editor

Preserve the confirmed cool blue / indigo palette, with shared V2 geometry.

## Content panel

- white surfaces and cool neutral borders;
- soft blue selected fields;
- blue focus ring.

## Code actions

44px hit-area remains. Dirty COPY uses solid `var(--ui-accent)` with white
`var(--ui-text-on-accent)` text, accent-hover and accent-active states.
No green brand gradient. Secondary actions stay white.
Lock selection uses soft blue and blue icon. Trash remains neutral to danger on hover.

## Preview chrome

Cool neutral workspace, white preview page, blue active viewport.
User HTML/CSS/JS and iframe content are never tinted by the service theme.

## External slider arrows

White surface, blue accent/border, neutral disabled state, 44x44 geometry preserved.

## Modal / code viewer

White surface, blue focus/accent, shared V2 shadow and geometry.
Portal owns `data-ui-theme="editor"`.

---

# 21. Instruction drawer

Optimizer instruction drawer may use the V2 gradient language. Editor drawers keep cool neutral surfaces and blue accents.

Recommended:

- white body;
- optional brand-gradient top section;
- white title on gradient;
- content in spacious white sections;
- green links/anchors;
- quiet dividers.

Desktop:

- slides from the right;
- 480–560px preferred reading width.

Mobile:

- near-full width;
- preserve small overlay context if possible.

---

# 22. “How it works” cards

Three-column cards remain appropriate.

Use:

- white surfaces;
- soft border;
- 16px radius;
- generous padding;
- small green step marker.

Optional very soft gradient:

```css
background:
  linear-gradient(
    145deg,
    #FFFFFF 0%,
    #F4F8F4 100%
  );
```

Do not make all three cards dark green.

---

# 23. Gradient density rule

For every Optimizer screen, ask:

> What is the single dominant green-gradient surface?

There should usually be one clear answer.

Examples:

Image Optimizer:
- primary CTA or a major helper/hero surface.

HTML Editor:
- no green-gradient surface; solid blue dirty action and cool neutral drawer.

Shell:
- no dominant gradient required.

If five or six elements compete with strong gradients, the system is being overused.

---

# 24. Responsive behavior

Visual styling must remain robust at:

```text
390
480
640
960
1200
1440
1920
2560
```

Do not change existing functional layout merely to apply this palette.

At wide widths:

- increase breathing room, not border weight;
- cards may grow but text should remain controlled;
- gradients must not become visually louder simply because the surface is larger.

---

# 25. Motion

```css
--ui-motion-fast: 120ms;
--ui-motion-normal: 160ms;
--ui-motion-slow: 240ms;
```

Transitions:

- background;
- border-color;
- color;
- box-shadow;
- opacity.

Avoid animated gradient movement.

No decorative floating effects.

Respect `prefers-reduced-motion`.

---

# 26. Accessibility

- visible `:focus-visible`;
- selected state not color-only;
- primary CTA contrast must meet accessibility requirements;
- white text only on sufficiently dark green;
- disabled state remains readable;
- do not remove semantic HTML / ARIA for styling.

---

# 27. Raw-color policy

Application UI components should use semantic tokens.

Do not scatter:

```css
#3F7847
#356C3E
#E4EFE5
```

through individual component selectors.

Use:

```css
var(--ui-accent)
var(--ui-gradient-brand)
var(--ui-accent-soft)
var(--ui-border)
```

Hard-coded functional exceptions are allowed only where justified.

Known exception:

```css
#F04444 /* crop smart guide */
```

---

# 28. User content isolation

This design system styles the Optima application only.

Never leak it into:

- HTML Preview iframe;
- user HTML;
- user CSS;
- user JS;
- generated site blocks;
- optimized image pixels.

Preview/editor markers may use Optima UI colors only when they are editor controls rather than user content.

---

# 29. Migration from V1

Remove from active UI:

- lime `#D9F45F`;
- softened lime `#D6E86A`;
- yellow help language;
- preserve Editor blue `#5B7CFA` (not a removal target);
- old cyan `#238FBC`;
- muddy olive accents;
- warm beige application background.

Replace with:

- botanical green for Optimizer and confirmed blue/indigo for Editor;
- mint Optimizer workspace and cool neutral Editor workspace;
- white cards;
- deep green gradients;
- peach warning;
- charcoal text.

Do not delete historical/dead CSS merely to clean statistics.

Change only selectors used by current Optima routes.

---

# 30. Implementation contract

A palette migration must not change product behavior.

Do not change while applying V2:

## Image Optimizer

- upload;
- batch;
- crop geometry;
- crop resize;
- red center guides;
- snap threshold;
- ratios;
- custom width;
- quality;
- HEIC;
- OxiPNG;
- PNG alpha;
- results;
- download lifecycle.

## HTML Content Editor

- blocks/fragments;
- source preserving patches;
- Site CSS/JS;
- lock lifecycle;
- dirty/COPY;
- composite text;
- video/media extraction;
- Preview iframe;
- sandbox/bridge;
- scale;
- slider navigation;
- Preview → Content behavior.

## Shared

- routes;
- service transition logic;
- SEO;
- privacy behavior;
- dependencies.

Palette migration is a visual operation.

---

# 31. Visual acceptance checklist

The V2 UI is correct when:

- Optimizer is pale mint + white + botanical green;
- there is no visible lime/yellow system;
- Editor retains its cool neutral + blue/indigo identity;
- gradients feel broad and calm;
- ordinary cards are predominantly white;
- service accents are concentrated in meaningful active/primary areas;
- text is almost black, not olive;
- selected states are soft;
- shadows are airy rather than heavy;
- the application feels related to the supplied references without copying their product content;
- Optimizer and Editor look like two tools inside one product.

---

# 32. Canonical V2 token block

Shared foundation and Optimizer root colors. Editor overrides colors only in section 33.

```css
:root {
  --ui-font-family:
    var(--font-onest),
    "Onest",
    system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;

  --ui-bg-app: #EFF4F0;
  --ui-bg-workspace: #E5EEE7;

  --ui-surface-1: #FFFFFF;
  --ui-surface-2: #F8FAF8;
  --ui-surface-3: #F1F5F2;
  --ui-surface-soft-green: #E8F1E9;

  --ui-text-primary: #151A16;
  --ui-text-secondary: #626B64;
  --ui-text-muted: #8B948D;
  --ui-text-disabled: #AEB6B0;

  --ui-border-soft: #E5EAE6;
  --ui-border: #D8E0DA;
  --ui-border-strong: #C5D1C7;

  --ui-accent: #3F7847;
  --ui-accent-hover: #356C3E;
  --ui-accent-active: #2E6037;
  --ui-accent-soft: #E4EFE5;
  --ui-accent-soft-strong: #D8E8DA;
  --ui-accent-border: #9DBDA1;
  --ui-accent-ink: #234B2C;
  --ui-text-on-accent: #FFFFFF;
  --ui-focus-ring: rgb(63 120 71 / 24%);

  --ui-success: #3F7847;
  --ui-success-soft: #E7F1E8;
  --ui-success-border: #B9D0BC;

  --ui-info: #567B5D;
  --ui-info-soft: #EDF4EE;
  --ui-info-border: #CADACD;

  --ui-warning: #A76B46;
  --ui-warning-soft: #FFF1E8;
  --ui-warning-border: #EAC7AF;

  --ui-danger: #C85E57;
  --ui-danger-hover: #B64F49;
  --ui-danger-soft: #FCECE9;
  --ui-danger-border: #E8B6B1;

  --ui-crop-guide: #F04444;

  --ui-gradient-brand:
    linear-gradient(
      135deg,
      #356C3E 0%,
      #3F7847 42%,
      #4C8254 100%
    );

  --ui-gradient-atmosphere:
    linear-gradient(
      135deg,
      #4B8052 0%,
      #5D9164 48%,
      #76A47A 100%
    );

  --ui-gradient-soft:
    linear-gradient(
      135deg,
      #F7FAF7 0%,
      #E7F0E8 100%
    );

  --ui-gradient-app:
    radial-gradient(
      circle at 18% 12%,
      rgb(255 255 255 / 78%) 0%,
      rgb(255 255 255 / 0%) 36%
    ),
    linear-gradient(
      135deg,
      #E8F1EA 0%,
      #F3F6F3 52%,
      #DDEADF 100%
    );

  --ui-gradient-glass:
    linear-gradient(
      135deg,
      rgb(255 255 255 / 16%) 0%,
      rgb(255 255 255 / 7%) 100%
    );

  --ui-radius-xs: 6px;
  --ui-radius-sm: 9px;
  --ui-radius-md: 12px;
  --ui-radius-lg: 16px;
  --ui-radius-xl: 20px;
  --ui-radius-pill: 999px;

  --ui-shadow-xs:
    0 2px 8px rgb(32 63 37 / 5%);
  --ui-shadow-sm:
    0 8px 24px rgb(32 63 37 / 7%);
  --ui-shadow-md:
    0 16px 40px rgb(32 63 37 / 10%);
  --ui-shadow-lg:
    0 28px 72px rgb(32 63 37 / 12%);

  --ui-motion-fast: 120ms;
  --ui-motion-normal: 160ms;
  --ui-motion-slow: 240ms;
}
```

This token block is the canonical visual foundation for Optima V2.

---

# 33. Canonical Editor palette

Confirmed PASS 3 colors; shared typography, geometry and shadows remain V2.
Compatibility roles alias existing soft blue and active indigo, without new gradients.

```css
[data-ui-theme="editor"] {
  --ui-bg-app: #F5F7FA;
  --ui-bg-workspace: #F3F5F8;
  --ui-surface-1: #FFFFFF;
  --ui-surface-2: #F8FAFC;
  --ui-surface-3: #F2F5F8;
  --ui-surface-hover: #F1F4F8;
  --ui-surface-pressed: #E9EEF5;
  --ui-surface-selected: #EEF4FF;
  --ui-text-primary: #202634;
  --ui-text-secondary: #667085;
  --ui-text-muted: #8B95A5;
  --ui-text-disabled: #B3BBC7;
  --ui-text-on-accent: #FFFFFF;
  --ui-border-soft: #E8ECF2;
  --ui-border: #DDE3EB;
  --ui-border-strong: #CBD3DF;
  --ui-accent: #5B7CFA;
  --ui-accent-hover: #4C6EEA;
  --ui-accent-active: #405FD3;
  --ui-accent-soft: #EEF3FF;
  --ui-accent-soft-strong: var(--ui-accent-soft);
  --ui-accent-border: #C8D6FF;
  --ui-accent-ink: var(--ui-accent-active);
  --ui-focus-ring: rgb(91 124 250 / 24%);
}
```
