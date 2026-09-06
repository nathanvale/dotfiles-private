/* Test-owned macOS host double. Invoked through the real public CLI/runner.
 * This executes production JXA; it does not prove real Chrome AX support. */
const fs = require('node:fs');
const vm = require('node:vm');
const [source, display, requestedURL] = process.argv.slice(2);
const scenario = process.env.FAKE_NATIVE_MODEL;
const target = 'https://fixture.invalid/PAGE-URL-SENTINEL-ONE';
const other = 'https://fixture.invalid/PAGE-URL-SENTINEL-TWO';
let selected = 1;
let pressed = false;
let reads = 0;
let clock = 0;
const scaled = scenario === 'scaled';
const step = () => { if (scaled) clock += 16; };
const comparisonTargets = {
  'bare-host': 'https://fixture.invalid/',
  'bare-host-query': 'https://fixture.invalid/?view=one',
  'bare-host-fragment': 'https://fixture.invalid/#one',
  'query-distinct': 'https://fixture.invalid/?view=two',
  'fragment-distinct': 'https://fixture.invalid/#two',
};
const urls = scaled ? Array.from({length: 12}, (_, index) => index === 10 ? target : `${other}?tab=${index}`) :
  comparisonTargets[scenario] ? [other, comparisonTargets[scenario]] :
  scenario === 'duplicate' ? [target, target] :
  scenario === 'absent' ? [other, 'chrome://newtab/'] : [other, target];
const log = value => {
  if (process.env.FAKE_NATIVE_MODEL_LOG) fs.appendFileSync(process.env.FAKE_NATIVE_MODEL_LOG, `${value}\n`);
};
const element = (values, children = [], actions = {}) => ({
  attributes: {byName: name => ({value: () => {
    step();
    if (typeof values[name] === 'function') return values[name]();
    return values[name] ?? null;
  }})},
  uiElements: () => { step(); return children; },
  actions: {byName: name => ({perform: () => {
    step();
    if (!actions[name]) throw new Error('unexpected UI operation');
    actions[name]();
  }})},
});
const tabs = urls.map((_, index) => element({
  AXRole: 'AXRadioButton', ChromeAXNodeId: index + 1,
  AXARIAPosInSet: index + 1, AXARIASetSize: scenario === 'hidden' ? 3 : urls.length,
  AXValue: () => selected === index + 1 ? 1 : 0,
}, [], {AXPress: () => {
  selected = index + 1;
  pressed = true;
  log(`selected:${selected}`);
}}));
const webArea = element({AXRole: 'AXWebArea'});
webArea.uiElements = () => { throw new Error('page content access forbidden'); };
const tabGroup = element({AXRole: 'AXTabGroup'}, tabs);
const profileWindow = element({
  AXRole: 'AXWindow', AXTitle: `Fixture - Google Chrome \u2013 Daily`, AXMinimized: false,
  AXDocument: () => {
    reads += 1;
    log(`url-read:${selected}`);
    if (scenario === 'unreadable') return null;
    if (scenario === 'selection-race') selected = selected === 1 ? 2 : 1;
    return urls[selected - 1];
  },
}, [tabGroup, webArea], {AXRaise: () => log('raised')});
const otherWindow = element({AXRole: 'AXWindow', AXTitle: 'Other - Google Chrome \u2013 Other'});
otherWindow.uiElements = () => { throw new Error('wrong profile inventory forbidden'); };
const chrome = {
  windows: () => {
    if (scenario === 'changed' && pressed) tabs[0].attributes.byName = () => ({value: () => null});
    if (scenario === 'missing-profile') return [otherWindow];
    if (scenario === 'ambiguous-profile') return [profileWindow, profileWindow, otherWindow];
    return [profileWindow, otherWindow];
  },
  set frontmost(value) { if (value !== true) throw new Error('unexpected focus'); log('focused'); },
};
const context = vm.createContext({
  Date: scaled ? {now: () => clock} : Date,
  Application: name => {
    if (name !== 'System Events') throw new Error('Chrome scripting forbidden');
    return {applicationProcesses: {whose: query => {
      if (query.bundleIdentifier !== 'com.google.Chrome') throw new Error('unscoped process');
      return () => scenario === 'closed' ? [] : [chrome];
    }}};
  },
});
vm.runInContext(fs.readFileSync(source, 'utf8'), context);
process.stdout.write(context.run([display, requestedURL]) + '\n');
log(`reads:${reads}`);
log(`clock:${clock}`);
