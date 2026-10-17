const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 10000;

/** Whether ANTHROPIC_API_KEY is set -- mirrors hereTraffic.js's isHereConfigured() pattern for an optional paid integration. */
function isLlmAssistConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function describeCandidate(candidate) {
  const zip = candidate.zipl || candidate.zipr;
  const zipPart = zip ? `ZIP ${zip}` : 'no known ZIP';
  const statePart = candidate.state_abbr ? `, ${candidate.state_abbr}` : '';
  return `${candidate.fullname} (${zipPart}${statePart})`;
}

function buildPrompt(originalInput, candidates) {
  const lettered = candidates
    .map((c, i) => `${String.fromCharCode(65 + i)}. ${describeCandidate(c)}`)
    .join('\n');
  return (
    `A caller tried to geocode this address in Maine or New Hampshire, but it ` +
    `didn't match any street exactly:\n\n"${originalInput}"\n\n` +
    `Here are the closest real street names Meridian already has on file nearby:\n${lettered}\n\n` +
    `If one of these is clearly what the caller meant (a misspelling, a wrong ` +
    `town, a missing ZIP), pick its letter. If none of them plausibly match, ` +
    `say "none". Never invent a street name that isn't in this list.`
  );
}

/**
 * Builds the tool definition with an `enum` sized to the real candidate
 * count (never more than MAX_CANDIDATES from geocodeMatching.js, so
 * always a handful of letters), plus `strict: true` so the schema
 * itself -- not just this module's own bounds-checking below -- rejects
 * anything Claude might return outside this exact set. Defense in
 * depth: the bounds check a few lines down already made this safe, this
 * makes the guarantee hold at the API boundary too.
 */
function buildPickCandidateTool(candidateCount) {
  const letters = Array.from({ length: candidateCount }, (_, i) => String.fromCharCode(65 + i));
  return {
    name: 'pick_candidate',
    description: "Pick the lettered candidate that best matches the caller's intended address, or \"none\" if nothing fits.",
    input_schema: {
      type: 'object',
      properties: {
        pick: {
          type: 'string',
          enum: [...letters, 'none'],
          description: 'The letter of the chosen candidate, or the literal string "none".',
        },
        reason: {
          type: 'string',
          description: 'One short sentence explaining the choice.',
        },
      },
      required: ['pick', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  };
}

/**
 * Asks Claude Haiku 4.5 to pick which of `candidates` (real street_names
 * rows -- see geocodeMatching.js's candidateStreetNames) the caller most
 * likely meant by `originalInput`, via forced tool-use so the response
 * can only ever be one of the candidates passed in, or the literal
 * "none" -- never a freely-generated street name.
 *
 * Returns { picked, failureReason }: picked is the chosen element of
 * `candidates` (the exact same object, not a copy), or null;
 * failureReason is 'none_fit' | 'llm_error' | null (null only when
 * picked is non-null). Never throws -- every failure mode (unconfigured,
 * timeout, non-2xx response, malformed/missing tool_use block, an
 * out-of-range letter) folds into failureReason: 'llm_error', so a
 * caller's failure path always degrades gracefully.
 *
 * Uses the raw `fetch` global with no retry on a transient 429/5xx --
 * deliberate, consistent with this codebase's HERE Traffic/Resend
 * convention of no SDK dependency; a single transient failure here just
 * means this one /geocode attempt doesn't get LLM-assisted (degrades to
 * the normal 404 via llmAssist.js's own outer catch), not a crash.
 */
async function pickCandidateWithLlm(originalInput, candidates) {
  if (!isLlmAssistConfigured()) return { picked: null, failureReason: 'llm_error' };
  if (!candidates || candidates.length === 0) return { picked: null, failureReason: 'llm_error' };

  const body = {
    model: MODEL,
    max_tokens: 300,
    tools: [buildPickCandidateTool(candidates.length)],
    tool_choice: { type: 'tool', name: 'pick_candidate' },
    messages: [{ role: 'user', content: buildPrompt(originalInput, candidates) }],
  };

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[anthropicClient] Anthropic API call failed:', err.message);
    return { picked: null, failureReason: 'llm_error' };
  }

  if (!response.ok) {
    console.error(`[anthropicClient] Anthropic API responded with status ${response.status}`);
    return { picked: null, failureReason: 'llm_error' };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('[anthropicClient] Anthropic API returned unparseable JSON:', err.message);
    return { picked: null, failureReason: 'llm_error' };
  }

  const toolUse = (data.content || []).find((block) => block.type === 'tool_use' && block.name === 'pick_candidate');
  if (!toolUse || !toolUse.input || typeof toolUse.input.pick !== 'string') {
    console.error('[anthropicClient] Anthropic API response had no usable pick_candidate tool_use block');
    return { picked: null, failureReason: 'llm_error' };
  }

  const { pick } = toolUse.input;
  if (pick.trim().toLowerCase() === 'none') return { picked: null, failureReason: 'none_fit' };

  const index = pick.toUpperCase().charCodeAt(0) - 65;
  if (index < 0 || index >= candidates.length) {
    console.error(`[anthropicClient] Anthropic picked an out-of-range letter: ${pick}`);
    return { picked: null, failureReason: 'llm_error' };
  }

  return { picked: candidates[index], failureReason: null };
}

module.exports = { isLlmAssistConfigured, pickCandidateWithLlm, buildPrompt, describeCandidate };
