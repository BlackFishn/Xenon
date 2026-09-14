import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
export const ACTION = 'com.custom.streamdock.xeneonedge.toggle';

export function createHandler(send, control, log = console.error) {
	const contexts = new Set();
	let busy = false;
	let state = 2;
	const paint = () => {
		for (const context of contexts) {
			send({ event: 'setState', context, payload: { state } });
		}
	};
	return async message => {
		if (message.action !== ACTION || typeof message.context !== 'string') return;
		const { event, context } = message;
		if (event === 'willDisappear') { contexts.delete(context); return; }
		if (event !== 'willAppear' && event !== 'keyDown') return;
		contexts.add(context);
		if (busy) { paint(); return; }
		busy = true;
		try {
			const result = await control(event === 'keyDown' ? 'toggle' : 'status');
			if (!result?.ok || typeof result.on !== 'boolean')
				throw new Error(result?.error || 'EDGE returned an invalid power state.');
			state = result.on ? 0 : 1;
		} catch (error) {
			state = 2;
			log(error.message);
			if (event === 'keyDown') send({ event: 'showAlert', context });
		} finally {
			busy = false;
			paint();
		}
	};
}

async function main() {
	const args = new Map();
	for (let i = 2; i + 1 < process.argv.length; i += 2)
		args.set(process.argv[i], process.argv[i + 1]);
	const port = Number(args.get('-port'));
	const uuid = args.get('-pluginUUID');
	const registration = args.get('-registerEvent');
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !uuid ||
		registration !== 'registerPlugin') throw new Error('Start this plugin from StreamDock.');
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const log = message => {
		try {
			const file = path.join(directory, 'plugin.log');
			if (existsSync(file) && statSync(file).size > 65536) writeFileSync(file, '');
			appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
		} catch { /* The key still shows an error if logging is unavailable. */ }
	};
	const send = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
	const control = async command => {
		let stdout;
		try {
			({ stdout } = await runFile(path.join(directory, 'EdgePower.exe'), [command], {
				windowsHide: true, timeout: 15000, maxBuffer: 8192,
			}));
		} catch (error) {
			if (!error.stdout) throw new Error('EDGE control failed or timed out. Press again to retry.');
			stdout = error.stdout;
		}
		return JSON.parse(stdout.trim());
	};
	const handle = createHandler(send, control, log);
	ws.on('open', () => {
		send({ event: registration, uuid });
		log('Connected to StreamDock');
	});
	ws.on('message', raw => {
		try { handle(JSON.parse(raw.toString())).catch(error => log(error.message)); }
		catch (error) { log(error.message); }
	});
	ws.on('error', error => log(error.message));
	ws.on('close', () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
