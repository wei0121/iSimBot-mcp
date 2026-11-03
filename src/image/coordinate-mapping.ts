/** Native screenshot pixels and HID points share a top-left origin in idb. */
export interface ScreenshotGeometry { udid: string; scale: number }

export function coordinateMapping(originalWidth: number, originalHeight: number,
  returnedWidth: number, returnedHeight: number, geometry?: ScreenshotGeometry) {
  if (!geometry || !Number.isFinite(geometry.scale) || geometry.scale <= 0) {
    return { available: false, reason: 'idb did not report screen_scale. Do not treat image pixels as touch points. Update idb/companion or use known simulator point coordinates.' };
  }
  const width = originalWidth / geometry.scale;
  const height = originalHeight / geometry.scale;
  return {
    available: true, deviceUdid: geometry.udid, origin: 'top-left', touchUnits: 'points',
    nativePixelsPerPoint: geometry.scale,
    touchSize: { width, height },
    touchPointsPerReturnedPixel: { x: width / returnedWidth, y: height / returnedHeight },
    formula: 'touchX = imageX * touchPointsPerReturnedPixel.x; touchY = imageY * touchPointsPerReturnedPixel.y',
    note: 'Use coordinates in the returned image, not a resized preview. Pass screenshotId to gestures for automatic conversion; without it they accept touch points. Recapture after rotation or device switching; this mapping belongs only to this capture. Scroll distance uses the factor of its movement axis.',
  };
}
