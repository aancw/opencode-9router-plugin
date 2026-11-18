// Minimal harness: load the built plugin and run setup with a mock ctx,
// mimicking how the opencode host invokes plugin.setup.
import plugin from "../dist/index.js";

const added = [];
const edits = [];
let defaultModel;

const ctx = {
  provider: {
    transform: async (cb) => {
      const editor = {
        add: (input) => added.push(input),
        list: () => [],
        get: () => undefined,
        update: () => {},
        remove: () => {},
        models: { set: () => {}, update: () => {}, remove: () => {} },
      };
      cb(editor);
    },
  },
  model: {
    transform: async (cb) => {
      const editor = {
        list: () => [],
        get: () => undefined,
        update: () => {},
        remove: () => {},
        default: {
          get: () => defaultModel,
          set: (p, m) => {
            defaultModel = { p, m };
          },
        },
        provider: { list: () => [], get: () => undefined },
      };
      cb(editor);
    },
  },
};

console.log("plugin id:", plugin.id);
await plugin.setup(ctx);
console.log("providers added:", added.length);
for (const p of added) {
  console.log("  info:", JSON.stringify(p.info));
  console.log("  models:", p.models?.length);
  console.log("  first model:", JSON.stringify(p.models?.[0], null, 2));
}
console.log("default:", defaultModel);
