const COMPAT_INIT_WARNING = 'using deprecated parameters for the initialization function; pass a single object instead';

let initialization;

// rapier3d-compat 0.19.x internally calls wasm-bindgen with its legacy byte-array
// signature and emits this warning even when consumers correctly call init()
// without arguments (upstream issue dimforge/rapier#811). Keep the workaround
// scoped to initialization and preserve every other warning.
export function initializeRapier(RAPIER) {
  if (initialization) return initialization;
  initialization = (async () => {
    const originalWarn = console.warn;
    const filteredWarn = (...args) => {
      if (args.length === 1 && args[0] === COMPAT_INIT_WARNING) return;
      originalWarn.apply(console, args);
    };
    console.warn = filteredWarn;
    try {
      await RAPIER.init();
    } finally {
      if (console.warn === filteredWarn) console.warn = originalWarn;
    }
  })();
  return initialization;
}
