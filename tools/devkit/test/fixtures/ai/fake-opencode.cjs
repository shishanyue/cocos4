const fs = require('node:fs');
const args = process.argv.slice(2);
const executable = process.platform === 'win32' ? process.argv[1].slice(0, -4) : process.argv[1];
if (args.length === 1 && args[0] === '--version') {
    fs.writeFileSync(`${executable}.probe`, JSON.stringify({
        providerPresent: !!process.env.ANTHROPIC_API_KEY,
        preloadPresent: !!process.env.NODE_OPTIONS,
    }));
    const version = fs.readFileSync(`${executable}.version`, 'utf8');
    if (version === 'wait') setInterval(() => {}, 1000);
    else process.stdout.write(version);
} else {
    if (args.length) throw new Error('Unexpected client argument passthrough.');
    const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
    console.log(JSON.stringify({ cwd: process.cwd(), args, configFile: process.env.OPENCODE_CONFIG,
        agent: config.default_agent, edit: config.permission.edit, safeWrite: config.permission.cocos4_write, mcp: config.mcp,
        provider: process.env.ANTHROPIC_API_KEY, customProvider: process.env.COCOS4_TEST_PROVIDER_TOKEN,
        preload: process.env.NODE_OPTIONS ?? null, home: process.env.HOME }));
    const scenario = fs.readFileSync(`${executable}.scenario`, 'utf8');
    if (scenario === 'wait') setInterval(() => {}, 1000);
    else process.exitCode = Number(scenario);
}
