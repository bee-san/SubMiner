type: added
area: overlay

- Added a `kwin` backend for KDE Plasma Wayland and auto-detected it in the launcher, app runtime, and mpv plugin.
- Added a KWin-backed mpv window tracker so the overlay can follow native Wayland mpv windows on Plasma.
- The KWin backend now uses a passive bridge: it follows the tracked mpv window geometry and visibility without trying to focus, raise, or otherwise mutate compositor window state.
- Native Plasma Wayland still keeps pointer events enabled for the overlay; clickthrough remains a separate limitation.
