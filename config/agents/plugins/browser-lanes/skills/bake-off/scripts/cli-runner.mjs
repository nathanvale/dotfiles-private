export function runBakeOffCli(argv, { usage, prefix, execute }) {
  const fileIndex = argv.indexOf('--file');
  if (fileIndex < 0 || !argv[fileIndex + 1]) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  try {
    const result = execute(argv, fileIndex);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } catch (cause) {
    console.error(`${prefix}: ${cause.message}`);
    process.exitCode = 2;
  }
}
