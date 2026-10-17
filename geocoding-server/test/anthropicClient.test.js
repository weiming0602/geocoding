const test = require('node:test');
const assert = require('node:assert/strict');

const { isLlmAssistConfigured, pickCandidateWithLlm } = require('../src/anthropicClient');

const CANDIDATES = [
  { fullname: 'Pequawket Trl', zipl: '04091', zipr: '04091', state_abbr: 'ME' },
  { fullname: 'State Rte 113', zipl: '04091', zipr: '04091', state_abbr: 'ME' },
];

test('isLlmAssistConfigured is false when ANTHROPIC_API_KEY is unset', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(isLlmAssistConfigured(), false);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('isLlmAssistConfigured is true when ANTHROPIC_API_KEY is set', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    assert.equal(isLlmAssistConfigured(), true);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

// pickCandidateWithLlm calls the real global fetch, so these tests
// replace it with a fake for the duration of each test and restore it
// afterward -- same technique hereTraffic.test.js already uses for
// HERE's fetch calls.
function withFakeFetch(respond, fn) {
  return async () => {
    const saved = global.fetch;
    global.fetch = respond;
    try {
      await fn();
    } finally {
      global.fetch = saved;
    }
  };
}

function withApiKey(fn) {
  return async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  };
}

test(
  'pickCandidateWithLlm: picks the candidate the tool-use response names',
  withFakeFetch(
    async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'claude-haiku-4-5-20251001');
      assert.equal(body.tool_choice.type, 'tool');
      assert.equal(body.tool_choice.name, 'pick_candidate');
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'A', reason: 'closest spelling' } }],
        }),
      };
    },
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, CANDIDATES[0]);
      assert.equal(failureReason, null);
    })
  )
);

test(
  'pickCandidateWithLlm: a second-letter pick resolves to the second candidate',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'B', reason: 'matches the alternate name' } }],
      }),
    }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 State Rt 113, 04091', CANDIDATES);
      assert.equal(picked, CANDIDATES[1]);
      assert.equal(failureReason, null);
    })
  )
);

test(
  'pickCandidateWithLlm: "none" resolves to picked null, failureReason none_fit',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'none', reason: 'nothing plausibly matches' } }],
      }),
    }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('123 Totally Different St, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'none_fit');
    })
  )
);

test(
  'pickCandidateWithLlm: an out-of-range letter resolves to failureReason llm_error, not a thrown error',
  withFakeFetch(
    async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'pick_candidate', input: { pick: 'Z', reason: 'oops' } }],
      }),
    }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test(
  'pickCandidateWithLlm: a fetch failure resolves to failureReason llm_error, not a thrown error',
  withFakeFetch(
    () => {
      throw new Error('network down');
    },
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test(
  'pickCandidateWithLlm: a non-2xx response resolves to failureReason llm_error, not a thrown error',
  withFakeFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test(
  'pickCandidateWithLlm: a response with no usable tool_use block resolves to failureReason llm_error',
  withFakeFetch(
    async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'I am confused' }] }) }),
    withApiKey(async () => {
      const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
      assert.equal(picked, null);
      assert.equal(failureReason, 'llm_error');
    })
  )
);

test('pickCandidateWithLlm: never calls fetch when ANTHROPIC_API_KEY is unset', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;
  global.fetch = () => {
    throw new Error('fetch should not have been called');
  };
  try {
    const { picked, failureReason } = await pickCandidateWithLlm('997 Peqwket Trl, 04091', CANDIDATES);
    assert.equal(picked, null);
    assert.equal(failureReason, 'llm_error');
  } finally {
    global.fetch = savedFetch;
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
