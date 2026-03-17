/**
 * Step 04 — Claude CLI Subprocess Wrapper tests.
 *
 * Unit tests for extractJSON (pure function, no external deps).
 * Unit tests for spawnClaude (with mocked exec via _setExecImpl).
 * Integration tests for spawnClaude (require INTEGRATION=1 + real claude CLI).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  extractJSON,
  ClaudeCliError,
  spawnClaude,
  _setExecImpl,
} from '../dist/claude.js';

// ---------------------------------------------------------------------------
// extractJSON — unit tests
// ---------------------------------------------------------------------------

describe('extractJSON', () => {
  it('1. parses clean JSON object', () => {
    const result = extractJSON('{"key": "value"}');
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('2. parses JSON wrapped in ```json``` fences', () => {
    const raw = 'Here is result:\n```json\n{"a":1}\n```\nDone.';
    const result = extractJSON(raw);
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('3. parses JSON with preamble and trailing text', () => {
    const raw = 'Preamble {"nested": {"deep": [1,2,3]}} trailing';
    const result = extractJSON(raw);
    assert.deepStrictEqual(result, { nested: { deep: [1, 2, 3] } });
  });

  it('4. parses JSON array', () => {
    const raw = '[{"a":1},{"b":2}]';
    const result = extractJSON(raw);
    assert.deepStrictEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  it('5. throws on text with no JSON', () => {
    assert.throws(
      () => extractJSON('no json here at all'),
      (err) => err instanceof Error && err.message.includes('No valid JSON found'),
    );
  });

  it('6. throws on unclosed JSON', () => {
    assert.throws(
      () => extractJSON('{"unclosed": '),
      (err) => err instanceof Error && err.message.includes('No valid JSON found'),
    );
  });

  it('7. skips invalid balanced braces and finds next valid JSON', () => {
    const raw = 'Text with {curly} braces but {"valid": true} json';
    const result = extractJSON(raw);
    assert.deepStrictEqual(result, { valid: true });
  });

  it('handles deeply nested objects', () => {
    const raw = '{"a":{"b":{"c":{"d":42}}}}';
    const result = extractJSON(raw);
    assert.deepStrictEqual(result, { a: { b: { c: { d: 42 } } } });
  });

  it('handles arrays at top level with preamble', () => {
    const raw = 'Some text before [1, 2, 3] and after';
    const result = extractJSON(raw);
    assert.deepStrictEqual(result, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCliError
// ---------------------------------------------------------------------------

describe('ClaudeCliError', () => {
  it('has correct name, message and attempts', () => {
    const err = new ClaudeCliError('something failed', 2);
    assert.strictEqual(err.name, 'ClaudeCliError');
    assert.strictEqual(err.message, 'something failed');
    assert.strictEqual(err.attempts, 2);
    assert.ok(err instanceof Error);
  });

  it('is instanceof Error', () => {
    const err = new ClaudeCliError('test', 1);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ClaudeCliError);
  });
});

// ---------------------------------------------------------------------------
// spawnClaude — unit tests with mocked exec
// ---------------------------------------------------------------------------

describe('spawnClaude (mocked)', () => {
  afterEach(() => {
    _setExecImpl(null); // restore default
  });

  it('6. successful call returns parsed JSON', async () => {
    _setExecImpl(async (_args, _timeout) => {
      return '{"result": 42}';
    });

    const result = await spawnClaude({
      prompt: 'test',
      model: 'sonnet',
    });
    assert.deepStrictEqual(result, { result: 42 });
  });

  it('7. exit code 1 then success on retry returns result', async () => {
    let callCount = 0;
    _setExecImpl(async (_args, _timeout) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Claude CLI exited with code 1');
      }
      return '{"retried": true}';
    });

    const result = await spawnClaude({
      prompt: 'test',
      model: 'sonnet',
    });
    assert.deepStrictEqual(result, { retried: true });
    assert.strictEqual(callCount, 2);
  });

  it('8. exit code 1 twice throws ClaudeCliError with attempts=2', async () => {
    let callCount = 0;
    _setExecImpl(async (_args, _timeout) => {
      callCount++;
      throw new Error('Claude CLI exited with code 1');
    });

    await assert.rejects(
      () => spawnClaude({ prompt: 'test', model: 'sonnet' }),
      (err) => {
        assert.ok(err instanceof ClaudeCliError);
        assert.strictEqual(err.attempts, 2);
        assert.ok(err.message.includes('2 attempts'));
        return true;
      },
    );
    assert.strictEqual(callCount, 2);
  });

  it('9. bad JSON from Claude throws immediately (no retry)', async () => {
    let callCount = 0;
    _setExecImpl(async (_args, _timeout) => {
      callCount++;
      return 'This is not JSON at all, just plain text.';
    });

    await assert.rejects(
      () => spawnClaude({ prompt: 'test', model: 'sonnet' }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No valid JSON'));
        return true;
      },
    );
    // Should NOT have retried
    assert.strictEqual(callCount, 1);
  });

  it('10. timeout throws immediately (no retry)', async () => {
    let callCount = 0;
    _setExecImpl(async (_args, _timeout) => {
      callCount++;
      const err = new Error('Command timed out');
      (/** @type {any} */ (err)).killed = true;
      throw err;
    });

    await assert.rejects(
      () => spawnClaude({ prompt: 'test', model: 'sonnet', timeout: 100 }),
      (err) => {
        assert.ok(err instanceof ClaudeCliError);
        assert.strictEqual(err.attempts, 1);
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
    // Should NOT have retried
    assert.strictEqual(callCount, 1);
  });

  it('passes correct args to exec function', async () => {
    let capturedArgs = null;
    let capturedTimeout = null;
    _setExecImpl(async (args, timeout) => {
      capturedArgs = args;
      capturedTimeout = timeout;
      return '{"ok": true}';
    });

    await spawnClaude({
      prompt: 'my prompt',
      model: 'sonnet',
      maxTurns: 3,
      timeout: 15_000,
    });

    assert.deepStrictEqual(capturedArgs, [
      '--model', 'sonnet',
      '--max-turns', '3',
      '--print',
      '-p', 'my prompt',
    ]);
    assert.strictEqual(capturedTimeout, 15_000);
  });

  it('uses default maxTurns=1 and timeout=30000', async () => {
    let capturedArgs = null;
    let capturedTimeout = null;
    _setExecImpl(async (args, timeout) => {
      capturedArgs = args;
      capturedTimeout = timeout;
      return '{"ok": true}';
    });

    await spawnClaude({
      prompt: 'test',
      model: 'sonnet',
    });

    assert.ok(capturedArgs.includes('1')); // maxTurns default
    assert.strictEqual(capturedTimeout, 30_000);
  });

  it('timeout via message string (TIMEOUT keyword)', async () => {
    let callCount = 0;
    _setExecImpl(async (_args, _timeout) => {
      callCount++;
      throw new Error('TIMEOUT: process exceeded limit');
    });

    await assert.rejects(
      () => spawnClaude({ prompt: 'test', model: 'sonnet', timeout: 100 }),
      (err) => {
        assert.ok(err instanceof ClaudeCliError);
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
    assert.strictEqual(callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// spawnClaude — integration tests (require real claude CLI)
// ---------------------------------------------------------------------------

describe('spawnClaude (integration)', { skip: !process.env.INTEGRATION }, () => {
  it('simple prompt returns parsed JSON', async () => {
    const result = await spawnClaude({
      prompt: 'Respond with exactly this JSON and nothing else: {"test": true}',
      model: 'sonnet',
      maxTurns: 1,
      timeout: 60_000,
    });
    assert.ok(result !== null && typeof result === 'object');
  });

  it('timeout (1ms) throws immediately', async () => {
    await assert.rejects(
      () => spawnClaude({
        prompt: 'Respond with {"test": true}',
        model: 'sonnet',
        maxTurns: 1,
        timeout: 1,
      }),
      (err) => {
        return (
          err instanceof ClaudeCliError ||
          (err instanceof Error && err.message.includes('timed out'))
        );
      },
    );
  });
});
