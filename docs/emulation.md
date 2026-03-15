# Device Emulation

Test responsive design by emulating mobile devices, tablets, and different screen sizes.

## Emulate a Device

```bash
chromex emulate <target> <device-name>
```

### Available Devices

| Device | Resolution | Scale | Type |
|--------|-----------|-------|------|
| `iphone-14` | 390 x 844 | 3x | Mobile |
| `iphone-15-pro` | 393 x 852 | 3x | Mobile |
| `ipad-pro` | 1024 x 1366 | 2x | Tablet |
| `pixel-7` | 412 x 915 | 2.625x | Mobile |
| `galaxy-s23` | 360 x 780 | 3x | Mobile |
| `macbook-air` | 1440 x 900 | 2x | Desktop |
| `desktop-1080p` | 1920 x 1080 | 1x | Desktop |
| `desktop-4k` | 3840 x 2160 | 1x | Desktop |

### Examples

```bash
# Test mobile layout
chromex emulate <target> iphone-14
chromex shot <target> /tmp/mobile.png

# Test tablet layout
chromex emulate <target> ipad-pro
chromex shot <target> /tmp/tablet.png

# Test large desktop
chromex emulate <target> desktop-4k
chromex shot <target> /tmp/4k.png
```

**Output:**
```
Emulating iphone-14: 390x844 @3x (mobile)
```

Mobile emulation also sets the appropriate User-Agent string, so server-side responsive detection works correctly.

## Reset Emulation

Return to the browser's default viewport.

```bash
chromex emulate <target> reset
```

**Output:**
```
Device emulation reset to default.
```

## Responsive Testing Workflow

Test a page across multiple devices:

```bash
TARGET="6BE827FA"
URL="https://example.com"

chromex nav $TARGET "$URL"
chromex waitfor $TARGET "main"

# Mobile
chromex emulate $TARGET iphone-14
chromex shot $TARGET /tmp/responsive-mobile.png

# Tablet
chromex emulate $TARGET ipad-pro
chromex shot $TARGET /tmp/responsive-tablet.png

# Desktop
chromex emulate $TARGET desktop-1080p
chromex shot $TARGET /tmp/responsive-desktop.png

# 4K
chromex emulate $TARGET desktop-4k
chromex shot $TARGET /tmp/responsive-4k.png

# Reset
chromex emulate $TARGET reset
```

## Geolocation Override

Simulate GPS coordinates for location-based features.

```bash
# Set location to Sao Paulo, Brazil
chromex geo <target> -23.5505 -46.6333

# Set with custom accuracy (meters)
chromex geo <target> 40.7128 -74.0060 10     # New York, 10m accuracy

# Clear geolocation override
chromex geo <target> reset
```

## Timezone Override

Change the browser's timezone for testing date/time formatting.

```bash
chromex timezone <target> "America/Sao_Paulo"
chromex timezone <target> "Asia/Tokyo"
chromex timezone <target> "Europe/London"
chromex timezone <target> reset
```

## Locale Override

Change the browser's locale for testing internationalization.

```bash
chromex locale <target> "pt-BR"
chromex locale <target> "ja-JP"
chromex locale <target> "en-US"
chromex locale <target> reset
```

## CPU Throttling

Simulate slower CPUs for performance testing on low-end devices.

```bash
# 4x slower (simulates mid-range mobile)
chromex cpu <target> 4

# 6x slower (simulates low-end mobile)
chromex cpu <target> 6

# Reset to normal speed
chromex cpu <target> reset
```

## Combine with Performance

Check if mobile performance meets Core Web Vitals:

```bash
chromex emulate <target> pixel-7
chromex cpu <target> 4
chromex throttle <target> 3g
chromex nav <target> "https://example.com"
chromex perf <target>
# Check LCP, FCP, CLS values
chromex emulate <target> reset
chromex cpu <target> reset
chromex throttle <target> reset
```

## Full i18n Testing Workflow

```bash
TARGET="6BE827FA"

# Simulate a user in Tokyo
chromex geo $TARGET 35.6762 139.6503
chromex timezone $TARGET "Asia/Tokyo"
chromex locale $TARGET "ja-JP"
chromex emulate $TARGET iphone-14

# Navigate and screenshot
chromex nav $TARGET "https://example.com"
chromex shot $TARGET /tmp/tokyo-mobile.png

# Reset everything
chromex geo $TARGET reset
chromex timezone $TARGET reset
chromex locale $TARGET reset
chromex emulate $TARGET reset
```
