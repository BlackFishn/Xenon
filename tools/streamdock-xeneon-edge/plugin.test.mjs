import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION, createHandler } from './com.custom.streamdock.xeneonedge.sdPlugin/plugin/index.mjs';

const event = (name, context = 'button') => ({ action: ACTION, context, event: name });

test('reads actual power on appearance and toggles only once per key press', async () => {
	const sent = [], commands = [];
	let on = true;
	const handle = createHandler(value => sent.push(value), async command => {
		commands.push(command);
		if (command === 'toggle') on = !on;
		return { ok: true, on };
	});
	await handle(event('willAppear'));
	assert.equal(sent.at(-1).payload.state, 0);
	await handle(event('keyDown'));
	await handle(event('keyUp'));
	assert.deepEqual(commands, ['status', 'toggle']);
	assert.equal(sent.at(-1).payload.state, 1);
	await handle(event('keyDown'));
	assert.equal(sent.at(-1).payload.state, 0);
});

test('rapid presses and multiple keys cannot race monitor writes', async () => {
	const sent = [];
	let finish, calls = 0;
	const handle = createHandler(value => sent.push(value), () => {
		calls++;
		return new Promise(resolve => { finish = resolve; });
	});
	const first = handle(event('keyDown', 'one'));
	await handle(event('keyDown', 'two'));
	assert.equal(calls, 1);
	finish({ ok: true, on: false });
	await first;
	assert.deepEqual(sent.slice(-2).map(value => [value.context, value.payload.state]),
		[['one', 1], ['two', 1]]);
});

test('failed or malformed state is shown as unknown, never as successful sleep', async () => {
	for (const result of [{ ok: false, error: 'Disconnected' }, { ok: true }]) {
		const sent = [], errors = [];
		const handle = createHandler(value => sent.push(value), async () => result,
			message => errors.push(message));
		await handle(event('keyDown'));
		assert.equal(sent.at(-1).payload.state, 2);
		assert.equal(sent[0].event, 'showAlert');
		assert.equal(errors.length, 1);
	}
});

test('foreign actions and removed keys do not trigger or receive controls', async () => {
	const sent = [];
	let calls = 0;
	const handle = createHandler(value => sent.push(value), async () => {
		calls++; return { ok: true, on: true };
	});
	await handle({ ...event('keyDown'), action: 'unrelated' });
	assert.equal(calls, 0);
	await handle(event('willAppear', 'removed'));
	await handle(event('willDisappear', 'removed'));
	sent.length = 0;
	await handle(event('willAppear', 'remaining'));
	assert.deepEqual(sent.map(value => value.context), ['remaining']);
});
