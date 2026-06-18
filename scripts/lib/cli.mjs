export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (const item of argv) {
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf('=');
    if (eq < 0) {
      args[item.slice(2)] = true;
    } else {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    }
  }
  return args;
}

export function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${name}=...`);
  }
  return value;
}

export function printJson(value) {
  console.log(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ), 2));
}

export function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
}

export function pickDefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
