// Loaded with `electron -r` by the GUI smoke test: keeps every window off-screen
// and never activates it, so a test run does not take over the desktop.
const { app, BrowserWindow } = require('electron');

const OFF = -32000;
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// README screenshots are taken at 2x
if (process.env.VELLUM_SMOKE_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.VELLUM_SMOKE_SCALE);

const proto = BrowserWindow.prototype;
const original = { showInactive: proto.showInactive, setBounds: proto.setBounds, setPosition: proto.setPosition };

proto.show = function show() {
  original.setPosition.call(this, OFF, OFF);
  original.showInactive.call(this);
};
for (const name of ['focus', 'moveTop', 'maximize', 'restore', 'setFullScreen', 'setSimpleFullScreen', 'setKiosk', 'center', 'flashFrame']) {
  proto[name] = function noop() {};
}
proto.setBounds = function setBounds(bounds, animate) {
  const current = this.getBounds();
  return original.setBounds.call(
    this,
    { x: OFF, y: OFF, width: bounds.width ?? current.width, height: bounds.height ?? current.height },
    animate,
  );
};
proto.setPosition = function setPosition(_x, _y, animate) {
  return original.setPosition.call(this, OFF, OFF, animate);
};
