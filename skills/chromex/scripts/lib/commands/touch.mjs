// Touch gestures via Input domain

export async function touchStr(cdp, sid, gesture, ...args) {
  if (!gesture) throw new Error('Usage: touch <target> tap <x> <y> | swipe <x1>,<y1> <x2>,<y2> | pinch <x> <y> <scale> | longpress <x> <y> [ms]');

  // Enable touch emulation
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);

  switch (gesture.toLowerCase()) {
    case 'tap': {
      const [x, y] = args.map(Number);
      if (isNaN(x) || isNaN(y)) throw new Error('Usage: touch <target> tap <x> <y>');
      await cdp.send('Input.synthesizeTapGesture', {
        x, y, duration: 50, tapCount: 1,
      }, sid);
      return `Tapped at (${x}, ${y}).`;
    }

    case 'swipe': {
      const [fromStr, toStr] = args;
      if (!fromStr || !toStr) throw new Error('Usage: touch <target> swipe <x1>,<y1> <x2>,<y2>');
      const [x1, y1] = fromStr.split(',').map(Number);
      const [x2, y2] = toStr.split(',').map(Number);
      if ([x1, y1, x2, y2].some(isNaN)) throw new Error('Invalid coordinates');

      await cdp.send('Input.synthesizeScrollGesture', {
        x: x1, y: y1,
        xDistance: x2 - x1,
        yDistance: y2 - y1,
        speed: 800,
        preventFling: true,
        gestureSourceType: 'touch',
      }, sid);
      return `Swiped from (${x1},${y1}) to (${x2},${y2}).`;
    }

    case 'pinch': {
      const [x, y, scale] = args.map(Number);
      if (isNaN(x) || isNaN(y) || isNaN(scale)) throw new Error('Usage: touch <target> pinch <x> <y> <scale>');
      await cdp.send('Input.synthesizePinchGesture', {
        x, y, scaleFactor: scale, relativeSpeed: 300,
        gestureSourceType: 'touch',
      }, sid);
      return `Pinch ${scale > 1 ? 'zoom in' : 'zoom out'} at (${x},${y}) scale=${scale}.`;
    }

    case 'longpress': {
      const [x, y, durationStr] = args;
      const cx = parseFloat(x);
      const cy = parseFloat(y);
      const duration = parseInt(durationStr) || 1000;
      if (isNaN(cx) || isNaN(cy)) throw new Error('Usage: touch <target> longpress <x> <y> [ms]');
      await cdp.send('Input.synthesizeTapGesture', {
        x: cx, y: cy, duration, tapCount: 1,
      }, sid);
      return `Long press at (${cx},${cy}) for ${duration}ms.`;
    }

    default:
      throw new Error(`Unknown gesture: ${gesture}. Available: tap, swipe, pinch, longpress`);
  }
}
