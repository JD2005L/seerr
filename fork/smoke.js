// Smoke test for a candidate image. deploy.sh runs it inside a throwaway
// container (no network) that uses a copy of the live config, so the writes
// below never reach production. Needs EXPECT_COMMIT.
// The William checks use live data: user 7's override rule and an existing
// fan-out row. Update them if that data changes.
const fs = require('fs');
const settings = require('/app/config/settings.json');
const base = 'http://127.0.0.1:5055';
const keyHeaders = { 'X-Api-Key': settings.main.apiKey };
const fail = (msg) => {
  throw new Error(msg);
};
async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { ...keyHeaders, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 120);
  }
  return { status: response.status, data };
}
const post = (body) =>
  call('/api/v1/request/fanout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const read = (q) => call('/api/v1/request/fanout/status?' + q);

(async () => {
  const status = await call('/api/v1/status');
  if (
    status.status !== 200 ||
    status.data.commitTag !== process.env.EXPECT_COMMIT
  )
    fail('wrong candidate identity: ' + JSON.stringify(status.data));

  const mapped = await call(
    '/api/v1/request/destination?mediaType=movie&userId=7'
  );
  if (
    mapped.status !== 200 ||
    mapped.data.rootFolder !== '/library/william/Movies' ||
    !mapped.data.tags.includes(101)
  )
    fail('William destination incorrect: ' + JSON.stringify(mapped.data));

  const owner = await read('mediaType=movie&tmdbId=1423191&owner=william');
  if (owner.status !== 200 || owner.data.owner !== 'william')
    fail('legacy intent lookup broken: ' + JSON.stringify(owner.data));

  const payload = {
    owner: 'william',
    mediaType: 'movie',
    tmdbId: 1423191,
    desiredState: 'present',
  };
  const first = await post(payload);
  const again = await post(payload);
  if (
    first.status !== 200 ||
    again.status !== 200 ||
    first.data.status !== again.data.status
  )
    fail('present is not idempotent');
  const absent = await post({ ...payload, desiredState: 'absent' });
  const absentAgain = await post({ ...payload, desiredState: 'absent' });
  if (
    absent.status !== 200 ||
    absentAgain.status !== 200 ||
    absent.data.status !== absentAgain.data.status
  )
    fail('absent is not idempotent');

  const movie = await post({
    owner: 'james',
    mediaType: 'movie',
    tmdbId: 12345,
    desiredState: 'present',
  });
  const tv = await post({
    owner: 'james',
    mediaType: 'tv',
    tmdbId: 12345,
    desiredState: 'present',
  });
  const tvdb = await post({
    owner: 'james',
    mediaType: 'tv',
    tvdbId: 12345,
    desiredState: 'present',
  });
  const reads = await Promise.all([
    read('mediaType=movie&tmdbId=12345&owner=james'),
    read('mediaType=tv&tmdbId=12345&owner=james'),
    read('mediaType=tv&tvdbId=12345&owner=james'),
  ]);
  if (
    [movie, tv, tvdb, ...reads].some((x) => x.status !== 200) ||
    reads.some((x) => x.data.status !== 'pending') ||
    new Set([movie.data.requestId, tv.data.requestId, tvdb.data.requestId])
      .size !== 3
  )
    fail('media identity collision');
  if (
    reads.some(
      (x) => typeof x.data.waitingSeconds !== 'number' || !x.data.requestedAt
    )
  )
    fail('waiting time missing: ' + JSON.stringify(reads[0].data));

  // Notify PVIBot. The smoke container has no network, so the send fails and
  // the request must still be saved and reported as not delivered.
  const helpCall = (path, body) =>
    call('/api/v1/request/fanout/help' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const help = await helpCall('', {
    owner: 'james',
    mediaType: 'movie',
    tmdbId: 12345,
    clientError: 'smoke test',
  });
  if (
    help.status !== 200 ||
    !(help.data.help?.id > 0) ||
    help.data.help.status !== 'send_failed'
  )
    fail('Notify PVIBot not saved: ' + JSON.stringify(help.data));
  const note = await helpCall(`/${help.data.help.id}/note`, {
    status: 'investigating',
    note: 'smoke test note',
  });
  if (note.status !== 200 || note.data.notes?.[0]?.text !== 'smoke test note')
    fail('PVIBot note not saved: ' + JSON.stringify(note.data));
  const helped = await read('mediaType=movie&tmdbId=12345&owner=james');
  if (helped.data.help?.id !== help.data.help.id)
    fail('help missing from status: ' + JSON.stringify(helped.data));
  const badNote = await helpCall(`/${help.data.help.id}/note`, {
    status: 'sent',
  });
  if (badNote.status !== 400)
    fail('invalid PVIBot status accepted: ' + badNote.status);

  const anon = await fetch(
    base + '/api/v1/request/fanout/status?mediaType=movie&tmdbId=1423191'
  );
  if (anon.status !== 401) fail('anonymous request authorized: ' + anon.status);
  const anonHelp = await fetch(base + '/api/v1/request/fanout/help', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaType: 'movie', tmdbId: 12345 }),
  });
  if (anonHelp.status !== 401)
    fail('anonymous Notify PVIBot authorized: ' + anonHelp.status);

  const dir = '/app/.next/static/chunks';
  const chunks = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) chunks.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  const has = (s) => chunks.some((c) => c.includes(s));
  if (!has('Notify PVIBot') || !has('library-toast'))
    fail('library feedback missing from client bundle');
  if (!has('Adding to ')) fail('fan-out button missing from client bundle');
  if (!has('request-as-self'))
    fail('Request As statement missing from client bundle');
  if (!has(process.env.EXPECT_COMMIT))
    fail('client bundle built without COMMIT_TAG');

  console.log(
    'SMOKE_OK ' +
      JSON.stringify({
        commit: status.data.commitTag,
        destination: mapped.data.rootFolder,
        legacyOwner: owner.data.owner,
        idempotent: {
          present: again.data.status,
          absent: absentAgain.data.status,
        },
        distinctIds: [
          movie.data.requestId,
          tv.data.requestId,
          tvdb.data.requestId,
        ],
        anonymous: anon.status,
        help: help.data.help.status,
      })
  );
})().catch((error) => {
  console.error('SMOKE_FAIL ' + error.message);
  process.exit(1);
});
