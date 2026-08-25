// Which install instruction to show, kept apart from the DOM so it can be
// tested. It cannot be tested through a browser: Chrome fires
// beforeinstallprompt whatever user agent string it is told to report, and
// display-mode cannot be emulated, so driving the page proves nothing about
// either branch.

/** @returns {string} the instruction for this browser, or '' if unknown. */
export function installHint({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent);
  // iPadOS reports itself as a Mac, and is distinguishable only by touch
  const iOS = /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const firefox = /Firefox\//.test(ua);
  // every browser string contains "Safari"; only Safari's contains nothing else
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|OPR\/|SamsungBrowser/.test(ua);

  if (iOS) {
    // The route moved: recent Safari hides the Share sheet behind the ... button,
    // and "Add to Home Screen" sits below the fold under "View More". Naming
    // both steps matters more than naming the button, since the button keeps
    // changing and the buried entry is what people actually fail to find.
    return 'On iPhone and iPad: open the Share sheet, then choose “Add to Home Screen”, '
      + 'tapping “View More” first if it is not listed. Recent versions of Safari put the '
      + 'Share sheet behind the ••• button in the toolbar; other browsers and older versions '
      + 'give it its own icon. iOS never offers an install prompt, so this is the only route.';
  }
  if (android) {
    return firefox
      ? 'On Android: open the Firefox menu, then “Install”.'
      : 'On Android: open the browser menu, then “Install app” or “Add to Home screen”.';
  }
  if (safari) return 'In Safari: choose File, then “Add to Dock”.';
  if (firefox) {
    return 'Firefox on the desktop cannot install web apps. Chrome, Edge and Safari can, '
      + 'or simply leave this tab open, since it works offline either way.';
  }
  return 'On the desktop: look for an install icon in the address bar, or “Install” in the browser menu.';
}

/** Already on the device, so there is nothing to suggest. */
export function isInstalled({ standaloneDisplay = false, iosStandalone = false } = {}) {
  return standaloneDisplay === true || iosStandalone === true;
}
